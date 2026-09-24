import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { getScimSettings, requireScimToken, type ScimSettings } from "../lib/scim-auth";
import {
  appToScim,
  appToState,
  applyPatch,
  listResponse,
  pageParams,
  parseFilterParam,
  parsePatchBody,
  parseScimUser,
  resourceTypes,
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
import { getBrand } from "../lib/settings";
import { ensureMailbox, getUserByEmail, insertUser, offboardStatements } from "../lib/users";
import { now } from "../lib/util";
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

async function readJson(c: C): Promise<unknown> {
  if (Number(c.req.header("content-length") ?? 0) > 100_000) throw new ScimError(413, "Request body is too large");
  try {
    return await c.req.json();
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
// Groups aren't provisioned; access to shared mailboxes is managed in the app.
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

/** A personal mailbox at <local part>@<primary domain>, unless that address is already in use (e.g. a shared inbox). */
async function provisionMailbox(c: C, userId: string, email: string, name: string): Promise<string | null> {
  const brand = await getBrand(c.env.DB);
  const address = `${email.split("@")[0]}@${brand.primaryDomain.toLowerCase()}`;
  const taken = await c.env.DB.prepare("SELECT 1 FROM mailboxes WHERE address = ?1 UNION ALL SELECT 1 FROM mailbox_aliases WHERE address = ?1")
    .bind(address)
    .first();
  if (taken) return null;
  return ensureMailbox(c.env.DB, { address, displayName: name, type: "personal", ownerId: userId });
}

scimRoutes.post("/Users", async (c) => {
  const state = parseScimUser(await readJson(c));
  const m = scimToApp(state);
  if (await getUserByEmail(c.env.DB, m.email)) throw new ScimError(409, `A user with userName ${m.email} already exists`, "uniqueness");
  const settings = await getScimSettings(c.env.DB);
  const active = m.active !== false;
  // Everyone SCIM creates is a member; roles are only ever granted in the app.
  const id = await insertUser(c.env.DB, {
    email: m.email,
    name: m.name || m.email.split("@")[0],
    role: "member",
    status: !active ? "disabled" : settings.onboarding === "sso" ? "active" : "invited",
  });
  if (m.externalId) await c.env.DB.prepare("UPDATE users SET scim_external_id = ? WHERE id = ?").bind(m.externalId, id).run();
  const mailboxId = active && settings.createMailbox ? await provisionMailbox(c, id, m.email, m.name) : null;
  let invited = false;
  if (active && settings.onboarding === "invite") {
    const url = await issueToken(c.env, id, "invite", "scim", 24 * 7);
    invited = await emailInvite(c.env, m.email, url, "your administrator", m.name);
  }
  await audit(c, {
    action: "scim.user_created",
    targetType: "user",
    targetId: id,
    actor: actor(c),
    meta: { email: m.email, externalId: m.externalId ?? null, active, mailboxId, onboarding: settings.onboarding, invited },
  });
  return sendUser(c, await loadUser(c, id), 201);
});

/** Apply a full (PUT) or patched state to an existing user, with the same side effects as the admin console. */
async function updateUser(c: C, target: ScimRow, state: ScimUserState, settings: ScimSettings) {
  const m = scimToApp(state);
  const privileged = target.role === "owner" || target.role === "admin";
  if (privileged && m.active === false && target.status !== "disabled") {
    throw new ScimError(403, `${target.email} is an ${target.role} and can't be deactivated through SCIM. Change their role or disable them in Admin → Users.`);
  }
  if (m.email !== target.email.toLowerCase()) {
    if (privileged) throw new ScimError(403, `The email of an ${target.role} can't be changed through SCIM.`);
    if (await getUserByEmail(c.env.DB, m.email)) throw new ScimError(409, `A user with userName ${m.email} already exists`, "uniqueness");
  }
  const status =
    m.active === false
      ? "disabled"
      : m.active === true && target.status === "disabled"
        ? target.password_hash || target.google_sub || settings.onboarding === "sso"
          ? "active"
          : "invited"
        : target.status;
  const name = m.name || target.name;
  const externalId = m.externalId === undefined ? target.scim_external_id : m.externalId;
  const changed = m.email !== target.email.toLowerCase() || name !== target.name || status !== target.status || externalId !== target.scim_external_id;
  if (!changed) return target;

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE users SET email = ?, name = ?, status = ?, scim_external_id = ?, updated_at = ? WHERE id = ?").bind(m.email, name, status, externalId, now(), target.id),
  ];
  if (status === "disabled" && target.status !== "disabled") stmts.push(...offboardStatements(c.env.DB, target.id));
  await c.env.DB.batch(stmts);
  await audit(c, {
    action: status === "disabled" && target.status !== "disabled" ? "scim.user_deactivated" : target.status === "disabled" && status !== "disabled" ? "scim.user_reactivated" : "scim.user_updated",
    targetType: "user",
    targetId: target.id,
    actor: actor(c),
    meta: { email: m.email, from: { email: target.email, name: target.name, status: target.status }, to: { email: m.email, name, status }, externalId },
  });
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
