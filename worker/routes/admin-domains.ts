import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { mailDomains } from "@shared/brand";
import { DOMAIN_RE, RESEND_REGIONS } from "@shared/setup";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { existingMail } from "../lib/dns";
import {
  connectProviderDomain,
  domainDetail,
  findProviderDomain,
  listMailDomains,
  MAX_DOMAINS,
  removeProviderDomain,
  saveDomainConfig,
} from "../lib/mail-domains";
import { getResendApiKey } from "../lib/provider-config";
import { explainKeyError, resend, ResendError } from "../lib/resend";
import { loadSettings } from "../lib/settings";
import { parseBody } from "../lib/validate";

/** Admin console: the mail domains, their provider status and DNS health. */
export const adminDomainRoutes = new Hono<AppEnv>();

const zDomain = z.string().trim().toLowerCase().regex(DOMAIN_RE, "Enter a domain like example.com");
const zRegion = z.enum(RESEND_REGIONS.map((r) => r.id) as [string, ...string[]]);

function domainParam(c: Context<AppEnv>): string {
  const name = (c.req.param("name") ?? "").toLowerCase();
  if (!DOMAIN_RE.test(name)) throw new HTTPException(400, { message: "That isn't a valid domain." });
  return name;
}

/** Turn a provider failure into a 4xx/5xx with a readable message. */
function providerFailure(err: unknown): never {
  if (err instanceof HTTPException) throw err;
  if (err instanceof ResendError) {
    const { problem, message } = explainKeyError(err);
    // 403 validation errors carry Resend's own explanation (e.g. "domain has been registered already").
    const msg = problem === "unknown" || err.code === "validation_error" ? err.message : message;
    throw new HTTPException(err.status === 429 ? 429 : err.status >= 500 ? 502 : 400, { message: msg });
  }
  throw err;
}

/** Raw list of domains in the provider account (kept for older callers). */
adminDomainRoutes.get("/", async (c) => {
  try {
    const { data } = await resend.listDomains(await getResendApiKey(c.env));
    return c.json(data);
  } catch (err) {
    // Sending-only API keys can't list domains; report instead of failing the page.
    return c.json({ error: err instanceof ResendError ? explainKeyError(err).message : "Unavailable" }, 200);
  }
});

/** Configured domains joined with their provider status. */
adminDomainRoutes.get("/status", async (c) => c.json(await listMailDomains(c.env)));

/** Before adding: does the domain already receive mail somewhere else? */
adminDomainRoutes.get("/lookup", async (c) => {
  const r = zDomain.safeParse(c.req.query("name") ?? "");
  if (!r.success) throw new HTTPException(400, { message: "Enter a domain like example.com" });
  return c.json({ name: r.data, ...(await existingMail(r.data)) });
});

/** Change which domains are used and which one is primary, in one go. */
adminDomainRoutes.put("/config", async (c) => {
  const body = await parseBody(c, z.object({ primaryDomain: z.union([zDomain, z.literal("")]), additionalDomains: z.array(zDomain).max(MAX_DOMAINS - 1) }));
  if (!body.primaryDomain && body.additionalDomains.length) throw new HTTPException(400, { message: "Choose a primary domain first." });
  const { brand } = await loadSettings(c.env.DB);
  const next = await saveDomainConfig(c.env, body.primaryDomain, body.additionalDomains, c.get("user").id);
  await audit(c, {
    action: "domains.updated",
    targetType: "settings",
    meta: { from: mailDomains(brand), to: mailDomains(next), primary: next.primaryDomain },
  });
  return c.json(await listMailDomains(c.env));
});

/** Add a domain: use it here and (when the provider is connected) create it there. */
adminDomainRoutes.post("/", async (c) => {
  const body = await parseBody(
    c,
    z.object({ name: zDomain, region: zRegion.optional(), receiving: z.boolean().default(true), primary: z.boolean().default(false) }),
  );
  const { brand } = await loadSettings(c.env.DB);
  const current = mailDomains(brand);
  if (!current.includes(body.name) && current.length >= MAX_DOMAINS) throw new HTTPException(400, { message: `You can use up to ${MAX_DOMAINS} domains.` });
  const makePrimary = body.primary || !brand.primaryDomain;
  const primary = makePrimary ? body.name : brand.primaryDomain;
  const additional = [...current, body.name].filter((d) => d !== primary);
  await saveDomainConfig(c.env, primary, additional, c.get("user").id);

  let providerError: string | null = null;
  if (await getResendApiKey(c.env)) {
    try {
      await connectProviderDomain(c.env, body.name, { region: body.region, receiving: body.receiving });
    } catch (err) {
      providerError = err instanceof ResendError ? (err.code === "validation_error" ? err.message : explainKeyError(err).message) : "Couldn't reach the email provider.";
    }
  }
  await audit(c, { action: "domains.added", targetType: "domain", targetId: body.name, meta: { primary: makePrimary, region: body.region ?? null, receiving: body.receiving, providerError } });
  const detail = await domainDetail(c.env, body.name);
  return c.json({ ...detail, providerError: providerError ?? detail.providerError }, 201);
});

adminDomainRoutes.get("/:name", async (c) => {
  const name = domainParam(c);
  return c.json(await domainDetail(c.env, name, { dns: c.req.query("dns") !== "0" }));
});

/** Create an already-configured domain in the provider. */
adminDomainRoutes.post("/:name/connect", async (c) => {
  const name = domainParam(c);
  const body = await parseBody(c, z.object({ region: zRegion.optional(), receiving: z.boolean().default(true) }));
  try {
    await connectProviderDomain(c.env, name, body);
  } catch (err) {
    providerFailure(err);
  }
  await audit(c, { action: "domains.connected", targetType: "domain", targetId: name, meta: body });
  return c.json(await domainDetail(c.env, name));
});

/** Ask the provider to check DNS now. */
adminDomainRoutes.post("/:name/verify", async (c) => {
  const name = domainParam(c);
  try {
    const d = await findProviderDomain(c.env, name);
    if (!d) throw new HTTPException(404, { message: "This domain isn't in Resend yet. Connect it first." });
    await resend.verifyDomain(await getResendApiKey(c.env), d.id);
  } catch (err) {
    providerFailure(err);
  }
  await audit(c, { action: "domains.verify_requested", targetType: "domain", targetId: name });
  return c.json(await domainDetail(c.env, name));
});

adminDomainRoutes.put("/:name/receiving", async (c) => {
  const name = domainParam(c);
  const { enabled } = await parseBody(c, z.object({ enabled: z.boolean() }));
  try {
    const d = await findProviderDomain(c.env, name);
    if (!d) throw new HTTPException(404, { message: "This domain isn't in Resend yet. Connect it first." });
    await resend.setDomainReceiving(await getResendApiKey(c.env), d.id, enabled);
  } catch (err) {
    providerFailure(err);
  }
  await audit(c, { action: enabled ? "domains.receiving_enabled" : "domains.receiving_disabled", targetType: "domain", targetId: name });
  return c.json(await domainDetail(c.env, name));
});

adminDomainRoutes.post("/:name/primary", async (c) => {
  const name = domainParam(c);
  const { brand } = await loadSettings(c.env.DB);
  const current = mailDomains(brand);
  if (!current.includes(name)) throw new HTTPException(404, { message: "Add this domain first." });
  await saveDomainConfig(c.env, name, current.filter((d) => d !== name), c.get("user").id);
  await audit(c, { action: "domains.primary_changed", targetType: "domain", targetId: name, meta: { from: brand.primaryDomain } });
  return c.json(await listMailDomains(c.env));
});

/** Stop using a domain here; `?provider=1` also deletes it from the provider. */
adminDomainRoutes.delete("/:name", async (c) => {
  const name = domainParam(c);
  const alsoProvider = c.req.query("provider") === "1";
  const { brand } = await loadSettings(c.env.DB);
  const current = mailDomains(brand);
  if (name === brand.primaryDomain && current.length > 1) {
    throw new HTTPException(400, { message: "This is the primary domain. Make another domain primary first." });
  }
  if (current.includes(name)) {
    const rest = current.filter((d) => d !== name);
    await saveDomainConfig(c.env, rest[0] ?? "", rest.slice(1), c.get("user").id);
  }
  let removedFromProvider = false;
  if (alsoProvider) {
    try {
      removedFromProvider = await removeProviderDomain(c.env, name);
    } catch (err) {
      providerFailure(err);
    }
  }
  await audit(c, { action: "domains.removed", targetType: "domain", targetId: name, meta: { removedFromProvider } });
  return c.json(await listMailDomains(c.env));
});
