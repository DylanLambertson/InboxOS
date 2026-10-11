import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env";
import { requireFeature } from "../lib/features";
import { audit } from "../lib/audit";
import { getScimSettings, requireScimToken, type ScimSettings } from "../lib/scim-auth";
import {
  appToScim,
  appToState,
  applyPatch,
  emailDomainAllowed,
  listResponse,
  pageParams,
  parseFilterParam,
  parsePatchBody,
  parseScimUser,
  personalMailboxAddress,
  resourceTypes,
  SCHEMA_LIST,
  SCHEMA_USER,
  SCIM_CONTENT_TYPE,
  scimErrorBody,
  ScimError,
  scimToApp,
  serviceProviderConfig,
  userEtag,
  userSchema,
  type AppUserLike,
  type ScimUserState,
} from "../lib/scim";
import { matchesFilter } from "../lib/scim-filter";
import { mailDomains } from "@shared/brand";
import { getBrand, getPolicy } from "../lib/settings";
import { ensureMailbox, getUserByEmail, insertUser, offboardStatements } from "../lib/users";
import { now } from "../lib/util";
import { emitFromRequest } from "../lib/webhooks";
import { emailInvite, issueToken } from "./admin-users";

/** SCIM 2.0 (RFC 7644) for Okta, Microsoft Entra ID and other identity providers. Mounted at /scim/v2. */
export const scimRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;

interface ScimRow extends AppUserLike {
  role: "owner" | "admin" | "member";
  password_hash: string | null;
  google_sub: string | null;
}

const COLUMNS = "id, email, name, role, status, scim_external_id, password_hash, google_sub, created_at, updated_at";
const baseUrl = (c: C) => `${c.env.APP_URL.replace(/\/$/, "")}/scim/v2`;
const actor = (c: C) => ({ id: c.get("scimTokenId"), email: "scim" });

function scim(c: C, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return c.body(JSON.stringify(body), status as 200, { "Content-Type": SCIM_CONTENT_TYPE, "Cache-Control": "no-store", ...headers });
}

scimRoutes.onError((err, c) => {
  if (err instanceof ScimError) return scim(c, scimErrorBody(err.status, err.message, err.scimType), err.status);
  if (err instanceof HTTPException) return scim(c, scimErrorBody(err.status, err.message || "Request failed"), err.status);
  console.error("scim", c.req.method, c.req.path, err);
  return scim(c, scimErrorBody(500, "Something went wrong"), 500);
});

scimRoutes.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});
scimRoutes.use("*", requireScimToken);
// After the token check, so only valid callers learn provisioning is switched off.
scimRoutes.use("*", requireFeature("provisioning"));

async function readJson(c: C): Promise<unknown> {
  // Measure the body itself; Content-Length is absent on chunked requests.
  const text = await c.req.text();
  if (text.length > 100_000) throw new ScimError(413, "Request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new ScimError(400, "Request body must be JSON", "invalidSyntax");
  }
}

// ---- Discovery --------------------------------------------------------------------------------
scimRoutes.get("/ServiceProviderConfig", (c) => scim(c, serviceProviderConfig(`${c.env.APP_URL.replace(/\/$/, "")}/admin/provisioning`)));
scimRoutes.get("/ResourceTypes", (c) => scim(c, listResponse(resourceTypes(baseUrl(c)), 1, 10)));
scimRoutes.get("/ResourceTypes/User", (c) => scim(c, resourceTypes(baseUrl(c))[0]));
scimRoutes.get("/Schemas", (c) => scim(c, listResponse([userSchema(baseUrl(c))], 1, 10)));
scimRoutes.get("/Schemas/:id", (c) => {
  if (c.req.param("id") !== SCHEMA_USER) throw new ScimError(404, "Schema not found");
  return scim(c, userSchema(baseUrl(c)));
});
// Groups aren't provisioned; access to shared mailboxes is managed in the app. Listing answers
// empty so Entra's default group sync finds nothing instead of logging errors every cycle.
scimRoutes.get("/Groups", (c) => scim(c, { schemas: [SCHEMA_LIST], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }));
scimRoutes.all("/Groups/*", () => {
  throw new ScimError(501, "Groups aren't supported. Assign people to the app individually.");
});
scimRoutes.all("/Groups", () => {
  throw new ScimError(501, "Groups aren't supported. Assign people to the app individually.");
});
scimRoutes.all("/Bulk", () => {
  throw new ScimError(501, "Bulk operations aren't supported");
});

// ---- Users ------------------------------------------------------------------------------------
async function loadUser(c: C, id: string): Promise<ScimRow> {
  const row = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).bind(id).first<ScimRow>();
  if (!row) throw new ScimError(404, `User ${id} not found`);
  return row;
}

function sendUser(c: C, row: ScimRow, status = 200) {
  const res = appToScim(row, baseUrl(c));
  return scim(c, res, status, { ETag: userEtag(row), ...(status === 201 ? { Location: res.meta.location } : {}) });
}

scimRoutes.get("/Users", async (c) => {
  const filter = parseFilterParam(c.req.query("filter"));
  const { start, count } = pageParams(c.req.query("startIndex"), c.req.query("count"));
  // A team's worth of accounts: filtering in memory keeps IdP input away from SQL entirely.
  const { results } = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at, id`).all<ScimRow>();
  const base = baseUrl(c);
  const all = results.map((r) => appToScim(r, base)).filter((r) => !filter || matchesFilter(r, filter));
  return scim(c, listResponse(all, start, count));
});

scimRoutes.get("/Users/:id", async (c) => sendUser(c, await loadUser(c, c.req.param("id"))));


/**
 * Bring an active account to life: a personal mailbox (if enabled, on a team domain, and the
 * address is free, e.g. not a shared inbox) and, in invite mode, the invite email.
 * Runs on create and when a never-onboarded account is reactivated.
 */
async function onboard(c: C, id: string, email: string, name: string, status: string, settings: ScimSettings) {
  let mailboxId: string | null = null;
  if (settings.createMailbox) {
    const owns = await c.env.DB.prepare(
      "SELECT 1 FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id WHERE mm.user_id = ? AND mm.role = 'owner' AND m.type = 'personal'",
    )
      .bind(id)
      .first();
    const address = owns ? null : personalMailboxAddress(email, mailDomains(await getBrand(c.env.DB)));
    const taken = address
      ? await c.env.DB.prepare("SELECT 1 FROM mailboxes WHERE address = ?1 UNION ALL SELECT 1 FROM mailbox_aliases WHERE address = ?1").bind(address).first()
      : null;
    if (address && !taken) mailboxId = await ensureMailbox(c.env.DB, { address, displayName: name, type: "personal", ownerId: id });
  }
  let invited = false;
  if (status === "invited" && settings.onboarding === "invite") {
    const url = await issueToken(c.env, id, "invite", "scim", 24 * 7);
    invited = await emailInvite(c.env, email, url, "your administrator", name);
  }
  return { mailboxId, invited };
}

scimRoutes.post("/Users", async (c) => {
  const state = parseScimUser(await readJson(c));
  const m = scimToApp(state);
  const taken = () => new ScimError(409, `A user with userName ${m.email} already exists`, "uniqueness");
  if (await getUserByEmail(c.env.DB, m.email)) throw taken();
  const settings = await getScimSettings(c.env.DB);
  const active = m.active !== false;
  const status = !active ? "disabled" : settings.onboarding === "sso" ? "active" : "invited";
  const name = m.name || m.email.split("@")[0];
  // Everyone SCIM creates is a member; roles are only ever granted in the app.
  let id: string;
  try {
    id = await insertUser(c.env.DB, { email: m.email, name, role: "member", status });
  } catch (e) {
    // Two concurrent creates for the same person: the loser gets a proper 409.
    if (String(e).includes("UNIQUE")) throw taken();
    throw e;
  }
  if (m.externalId) await c.env.DB.prepare("UPDATE users SET scim_external_id = ? WHERE id = ?").bind(m.externalId, id).run();
  const done = active ? await onboard(c, id, m.email, name, status, settings) : { mailboxId: null, invited: false };
  await audit(c, {
    action: "scim.user_created",
    targetType: "user",
    targetId: id,
    actor: actor(c),
    meta: { email: m.email, externalId: m.externalId ?? null, active, onboarding: settings.onboarding, ...done },
  });
  emitFromRequest(c, [{ type: "user.created", data: { id, email: m.email, name, role: "member", status, via: "scim" } }]);
  return sendUser(c, await loadUser(c, id), 201);
});

/** Apply a full (PUT) or patched state to an existing user, with the same side effects as the admin console. */
async function updateUser(c: C, target: ScimRow, state: ScimUserState, settings: ScimSettings) {
  const m = scimToApp(state);
  const privileged = target.role === "owner" || target.role === "admin";
  const wantStatus = m.active === false ? "disabled" : m.active === true && target.status === "disabled" ? "enable" : null;
  // Owners and admins are managed only in the app: SCIM can't disable them, nor re-enable one
  // an admin disabled (e.g. after a compromise), nor move their sign-in email.
  if (privileged && ((wantStatus === "disabled" && target.status !== "disabled") || wantStatus === "enable")) {
    throw new ScimError(403, `${target.email} is an ${target.role}; their access can't be changed through SCIM. Use Admin → Users.`);
  }
  const emailChanged = m.email !== target.email.toLowerCase();
  if (emailChanged) {
    if (privileged) throw new ScimError(403, `The email of an ${target.role} can't be changed through SCIM.`);
    const brand = await getBrand(c.env.DB);
    const policy = await getPolicy(c.env.DB);
    if (!emailDomainAllowed(m.email, [...mailDomains(brand), ...policy.googleAllowedDomains])) {
      throw new ScimError(400, `${m.email} isn't on one of the team's domains`, "invalidValue");
    }
    if (await getUserByEmail(c.env.DB, m.email)) throw new ScimError(409, `A user with userName ${m.email} already exists`, "uniqueness");
  }
  const status =
    wantStatus === "disabled"
      ? "disabled"
      : wantStatus === "enable"
        ? target.password_hash || target.google_sub || settings.onboarding === "sso"
          ? "active"
          : "invited"
        : target.status;
  const name = m.name || target.name;
  const externalId = m.externalId === undefined ? target.scim_external_id : m.externalId;
  if (!emailChanged && name === target.name && status === target.status && externalId === target.scim_external_id) return target;

  const t = now();
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE users SET email = ?, name = ?, status = ?, scim_external_id = ?, updated_at = ? WHERE id = ?").bind(m.email, name, status, externalId, t, target.id),
  ];
  if (status === "disabled" && target.status !== "disabled") stmts.push(...offboardStatements(c.env.DB, target.id));
  else if (emailChanged) {
    // A new sign-in address: end sessions and void outstanding invite/reset links sent to the old one.
    stmts.push(c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id));
    stmts.push(c.env.DB.prepare("UPDATE tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(t, target.id));
  }
  await c.env.DB.batch(stmts);
  const reactivated = target.status === "disabled" && status !== "disabled";
  const done = reactivated ? await onboard(c, target.id, m.email, name, status, settings) : null;
  await audit(c, {
    action: status === "disabled" && target.status !== "disabled" ? "scim.user_deactivated" : reactivated ? "scim.user_reactivated" : "scim.user_updated",
    targetType: "user",
    targetId: target.id,
    actor: actor(c),
    meta: { email: m.email, from: { email: target.email, name: target.name, status: target.status }, to: { email: m.email, name, status }, externalId, ...done },
  });
  if (status === "disabled" && target.status !== "disabled") {
    emitFromRequest(c, [{ type: "user.disabled", data: { id: target.id, email: m.email, name, role: target.role, status, via: "scim" } }]);
  }
  return loadUser(c, target.id);
}

scimRoutes.put("/Users/:id", async (c) => {
  const target = await loadUser(c, c.req.param("id"));
  const state = parseScimUser(await readJson(c));
  return sendUser(c, await updateUser(c, target, state, await getScimSettings(c.env.DB)));
});

scimRoutes.patch("/Users/:id", async (c) => {
  const target = await loadUser(c, c.req.param("id"));
  const ops = parsePatchBody(await readJson(c));
  const state = applyPatch(appToState(target), ops);
  return sendUser(c, await updateUser(c, target, state, await getScimSettings(c.env.DB)));
});

// Deprovisioning deactivates rather than deletes: mail, mailboxes and the audit trail stay.
scimRoutes.delete("/Users/:id", async (c) => {
  const target = await loadUser(c, c.req.param("id"));
  await updateUser(c, target, { ...appToState(target), active: false }, await getScimSettings(c.env.DB));
  return c.body(null, 204);
});

scimRoutes.all("*", (c) => scim(c, scimErrorBody(404, "Not found"), 404));
