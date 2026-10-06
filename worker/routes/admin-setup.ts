import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { mailDomains } from "@shared/brand";
import { deriveSteps, nextStep, SETUP_STEPS, setupProgress, SUGGESTED_MAILBOXES, WEBHOOK_EVENTS } from "@shared/setup";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { clearCredential, getResendApiKey, isFromEnv, providerStatus, storeCredential } from "../lib/provider-config";
import { checkApiKey, explainKeyError, looksLikeApiKey, resend, ResendError } from "../lib/resend";
import { loadSettings } from "../lib/settings";
import { loadSetupFacts, loadSetupState, setupKeySource, updateSetupState, webhookEndpoint, webhookUrlProblem } from "../lib/setup";
import { setupTestRoutes, setupTeamRoutes } from "./admin-setup-actions";
import { parseBody } from "../lib/validate";

/**
 * Admin console: the setup wizard's server side. Anyone in the console can read the
 * status; only owners can change credentials or setup progress.
 */
export const adminSetupRoutes = new Hono<AppEnv>();

export const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.get("user").role !== "owner") throw new HTTPException(403, { message: "Only an owner can change setup." });
  await next();
};
adminSetupRoutes.use("*", ownerOnly);

adminSetupRoutes.get("/", async (c) => {
  const state = await loadSetupState(c.env.DB);
  const [facts, provider, { brand, workspace }] = await Promise.all([loadSetupFacts(c.env, state), providerStatus(c.env), loadSettings(c.env.DB)]);
  const steps = deriveSteps(facts);
  const me = c.get("user");
  const mailboxes = await c.env.DB.prepare("SELECT id, address, name, type FROM mailboxes WHERE is_active = 1 AND is_system = 0 ORDER BY type, address").all<{
    id: string;
    address: string;
    name: string;
    type: string;
  }>();
  const users = await c.env.DB.prepare("SELECT COUNT(*) AS n, SUM(status = 'invited') AS invited FROM users").first<{ n: number; invited: number | null }>();
  return c.json({
    completed: !!state.completedAt,
    completedAt: state.completedAt,
    dismissed: !!state.dismissedAt,
    steps,
    nextStep: nextStep(steps),
    progress: setupProgress(steps),
    setupKeySource: setupKeySource(c.env),
    me: { id: me.id, name: me.name, email: me.email, role: me.role },
    useCase: workspace.useCase,
    suggestedMailboxes: SUGGESTED_MAILBOXES[workspace.useCase],
    primaryDomain: brand.primaryDomain,
    domains: facts.domains,
    provider,
    webhook: {
      endpoint: webhookEndpoint(c.env.APP_URL),
      problem: webhookUrlProblem(c.env.APP_URL),
      registered: state.webhook,
      secretFromEnv: isFromEnv(c.env, "webhookSecret"),
    },
    mailboxes: mailboxes.results,
    users: { total: users?.n ?? 0, invited: users?.invited ?? 0 },
    test: state.test,
  });
});

/** Skip a step for later, take it back up, finish setup, or hide the reminder banner. */
adminSetupRoutes.put("/progress", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      skip: z.enum(SETUP_STEPS).optional(),
      unskip: z.enum(SETUP_STEPS).optional(),
      complete: z.boolean().optional(),
      dismiss: z.boolean().optional(),
    }),
  );
  const state = await updateSetupState(c.env.DB, c.get("user").id, (s) => {
    if (body.skip) s.skipped = [...s.skipped, body.skip];
    if (body.unskip) s.skipped = s.skipped.filter((x) => x !== body.unskip);
    if (body.complete !== undefined) s.completedAt = body.complete ? s.completedAt ?? new Date().toISOString() : null;
    if (body.dismiss !== undefined) s.dismissedAt = body.dismiss ? new Date().toISOString() : null;
  });
  if (body.complete) await audit(c, { action: "setup.completed", targetType: "settings" });
  return c.json({ ok: true, skipped: state.skipped, completedAt: state.completedAt, dismissedAt: state.dismissedAt });
});

// ---- Email provider key ----------------------------------------------------

/** Save the Resend API key after checking it with Resend. */
adminSetupRoutes.put("/provider", async (c) => {
  const { apiKey } = await parseBody(c, z.object({ apiKey: z.string().trim().min(1, "Paste your API key").max(300) }));
  if (!looksLikeApiKey(apiKey)) throw new HTTPException(400, { message: "That doesn't look like a Resend API key. They start with re_." });
  const check = await checkApiKey(apiKey);
  if (!check.ok) throw new HTTPException(400, { message: check.message });
  await storeCredential(c.env, "apiKey", apiKey, c.get("user").id);
  await audit(c, { action: "setup.provider_key_saved", targetType: "settings", meta: { overriddenByEnv: isFromEnv(c.env, "apiKey") } });
  return c.json({ ...(await providerStatus(c.env)), domainCount: check.domainCount, overriddenByEnv: isFromEnv(c.env, "apiKey") });
});

/** Check the key that's in use right now. */
adminSetupRoutes.post("/provider/test", async (c) => {
  const check = await checkApiKey(await getResendApiKey(c.env));
  await audit(c, { action: "setup.provider_key_tested", targetType: "settings", meta: { ok: check.ok, problem: check.ok ? null : check.problem } });
  return c.json(check);
});

adminSetupRoutes.delete("/provider", async (c) => {
  const removed = await clearCredential(c.env, "apiKey");
  await audit(c, { action: "setup.provider_key_removed", targetType: "settings", meta: { removed } });
  return c.json({ ...(await providerStatus(c.env)), stillSetInEnv: isFromEnv(c.env, "apiKey") });
});

// ---- Webhook ---------------------------------------------------------------

/**
 * Register ${APP_URL}/webhooks/resend for every email event and keep its signing secret.
 * An existing webhook for the same URL is replaced, because its secret can't be read back.
 */
adminSetupRoutes.post("/webhook", async (c) => {
  const problem = webhookUrlProblem(c.env.APP_URL);
  if (problem) throw new HTTPException(400, { message: problem });
  const key = await getResendApiKey(c.env);
  if (!key) throw new HTTPException(400, { message: "Connect the email provider first." });
  const endpoint = webhookEndpoint(c.env.APP_URL);
  let created: { id: string; signingSecret: string };
  let replaced = 0;
  try {
    const existing = (await resend.listWebhooks(key)).filter((w) => w.endpoint.replace(/\/$/, "") === endpoint);
    created = await resend.createWebhook(key, endpoint, WEBHOOK_EVENTS);
    for (const w of existing) {
      await resend.deleteWebhook(key, w.id).catch((err) => console.error("could not remove old webhook", w.id, err));
      replaced++;
    }
  } catch (err) {
    const msg = err instanceof ResendError ? (err.code === "validation_error" ? err.message : explainKeyError(err).message) : "Couldn't reach the email provider.";
    throw new HTTPException(400, { message: msg });
  }
  await storeCredential(c.env, "webhookSecret", created.signingSecret, c.get("user").id);
  await updateSetupState(c.env.DB, c.get("user").id, (s) => {
    s.webhook = { id: created.id, endpoint, source: "auto", at: new Date().toISOString() };
  });
  await audit(c, { action: "setup.webhook_registered", targetType: "settings", meta: { endpoint, replaced, overriddenByEnv: isFromEnv(c.env, "webhookSecret") } });
  return c.json({ ok: true, endpoint, replaced, provider: await providerStatus(c.env) });
});

/** Paste a signing secret by hand (for a webhook created in the Resend dashboard). */
adminSetupRoutes.put("/webhook", async (c) => {
  const { secret } = await parseBody(c, z.object({ secret: z.string().trim().max(300) }));
  if (!/^whsec_[A-Za-z0-9+/=]{16,}$/.test(secret)) throw new HTTPException(400, { message: "Signing secrets start with whsec_. Copy it from the webhook's page in Resend." });
  await storeCredential(c.env, "webhookSecret", secret, c.get("user").id);
  await updateSetupState(c.env.DB, c.get("user").id, (s) => {
    s.webhook = { id: null, endpoint: webhookEndpoint(c.env.APP_URL), source: "manual", at: new Date().toISOString() };
  });
  await audit(c, { action: "setup.webhook_secret_saved", targetType: "settings" });
  return c.json({ ok: true, provider: await providerStatus(c.env) });
});

/** Forget the signing secret, and remove the webhook from Resend if this app created it. */
adminSetupRoutes.delete("/webhook", async (c) => {
  const state = await loadSetupState(c.env.DB);
  let removedFromProvider = false;
  if (state.webhook?.id) {
    try {
      await resend.deleteWebhook(await getResendApiKey(c.env), state.webhook.id);
      removedFromProvider = true;
    } catch (err) {
      console.error("could not delete webhook", err);
    }
  }
  await clearCredential(c.env, "webhookSecret");
  await updateSetupState(c.env.DB, c.get("user").id, (s) => {
    s.webhook = null;
  });
  await audit(c, { action: "setup.webhook_removed", targetType: "settings", meta: { removedFromProvider } });
  return c.json({ ok: true, removedFromProvider, stillSetInEnv: isFromEnv(c.env, "webhookSecret"), provider: await providerStatus(c.env) });
});

/** Domains in the provider that aren't used here yet (to offer as a shortcut). */
adminSetupRoutes.get("/provider/domains", async (c) => {
  const { brand } = await loadSettings(c.env.DB);
  const used = mailDomains(brand);
  try {
    const { data } = await resend.listDomains(await getResendApiKey(c.env));
    return c.json(data.map((d) => ({ name: d.name, status: d.status, used: used.includes(d.name.toLowerCase()) })));
  } catch {
    return c.json([]);
  }
});

adminSetupRoutes.route("/", setupTeamRoutes);
adminSetupRoutes.route("/test", setupTestRoutes);
