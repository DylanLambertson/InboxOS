import { Hono } from "hono";
import { z } from "zod";
import { DLP_RULES, type DlpRuleId, type OutboundPolicy } from "@shared/outbound";
import type { Address } from "@shared/types";
import type { AppEnv } from "../env";
import { requireFeature } from "../lib/features";
import { requireMailbox, requireMessage } from "../lib/access";
import { audit } from "../lib/audit";
import { summarizeFindings } from "../lib/dlp";
import type { AttachmentRow, ComposeMeta, MessageRow } from "../lib/messages";
import { cleanTemplateHtml, companySignature, evaluateDlp, externalRecipients, getOutboundPolicy, saveOutboundPolicy } from "../lib/outbound";
import { getBrand } from "../lib/settings";
import { parseJson } from "../lib/util";
import { parseBody, zId } from "../lib/validate";

/** Signed-in users: the signature compose should use, and the pre-send DLP check. */
export const outboundRoutes = new Hono<AppEnv>();

outboundRoutes.get("/signature", async (c) => {
  const mailboxId = c.req.query("mailboxId") ?? "";
  const db = c.env.DB;
  const policy = await getOutboundPolicy(db);
  if (policy.signature.mode === "off") return c.json({ mode: "off", html: "" });
  // Without a mailbox (Settings → Profile) the org template renders with the user's own address.
  if (mailboxId) await requireMailbox(db, c.get("user"), mailboxId, "viewer");
  const html = await companySignature(db, policy, await getBrand(db), { userId: c.get("user").id, mailboxId });
  return c.json({ mode: policy.signature.mode, html });
});

/** Findings for a saved draft, so compose can warn before the undo-send timer starts. */
outboundRoutes.post("/check", async (c) => {
  const { draftId } = await parseBody(c, z.object({ draftId: zId }));
  const db = c.env.DB;
  const m = await requireMessage<MessageRow>(db, c.get("user"), draftId, "editor");
  const [policy, brand, htmlObj, { results: atts }] = await Promise.all([
    getOutboundPolicy(db),
    getBrand(db),
    m.html_key ? c.env.FILES.get(m.html_key) : null,
    db.prepare("SELECT filename FROM attachments WHERE message_id = ?").bind(m.id).all<Pick<AttachmentRow, "filename">>(),
  ]);
  const meta = parseJson<ComposeMeta>(m.compose_meta, {});
  const recipients = [...parseJson<Address[]>(m.to_json, []), ...parseJson<Address[]>(m.cc_json, []), ...parseJson<Address[]>(m.bcc_json, [])];
  const findings = evaluateDlp(policy, brand, {
    subject: m.subject,
    bodyHtml: htmlObj ? await htmlObj.text() : "",
    quoteHtml: meta.quoteHtml ?? "",
    recipients,
    filenames: atts.map((a) => a.filename),
  });
  const blocked = findings.filter((f) => f.action === "block");
  // Record refused attempts; warnings are logged when (and if) the message actually goes out.
  if (blocked.length) {
    await audit(c, { action: "dlp.blocked", targetType: "message", targetId: m.id, meta: { rules: summarizeFindings(blocked), mailboxId: m.mailbox_id, via: "precheck" } });
  }
  return c.json({ findings, external: externalRecipients(recipients, brand).length });
});

// ---- Admin --------------------------------------------------------------------

const zAction = z.enum(["off", "warn", "block"]);
const zRule = z.object({ action: zAction, scope: z.enum(["external", "all"]) });
const zTemplate = z.string().max(20_000);

const zOutbound = z.object({
  signature: z.object({
    mode: z.enum(["off", "suggest", "enforce"]),
    template: zTemplate,
    mailboxTemplates: z.record(zId, zTemplate).refine((r) => Object.keys(r).length <= 500, "Too many mailbox overrides"),
  }),
  disclaimer: z.object({ enabled: z.boolean(), text: z.string().max(5_000), externalOnly: z.boolean() }),
  dlp: z.object({
    rules: z.object(Object.fromEntries(DLP_RULES.map((r) => [r.id, zRule])) as Record<DlpRuleId, typeof zRule>),
    keywords: z.array(z.string().trim().min(2, "Keywords need at least 2 characters").max(100)).max(200),
  }),
});

/** Admins edit; managers can view (requireConsole lets them GET only). */
export const adminOutboundRoutes = new Hono<AppEnv>();
adminOutboundRoutes.use("*", requireFeature("outboundPolicy"));

adminOutboundRoutes.get("/", async (c) => {
  const [policy, { results: mailboxes }] = await Promise.all([
    getOutboundPolicy(c.env.DB),
    c.env.DB.prepare("SELECT id, address, display_name AS displayName FROM mailboxes WHERE is_active = 1 AND is_system = 0 ORDER BY address").all<{
      id: string;
      address: string;
      displayName: string;
    }>(),
  ]);
  return c.json({ policy, mailboxes });
});

adminOutboundRoutes.put("/", async (c) => {
  const body = await parseBody(c, zOutbound);
  const prev = await getOutboundPolicy(c.env.DB);
  const overrides = Object.fromEntries(
    Object.entries(body.signature.mailboxTemplates)
      .map(([id, html]) => [id, cleanTemplateHtml(html)] as const)
      .filter(([, html]) => html),
  );
  const next: OutboundPolicy = {
    signature: { ...body.signature, template: cleanTemplateHtml(body.signature.template), mailboxTemplates: overrides },
    disclaimer: { ...body.disclaimer, text: body.disclaimer.text.trim() },
    dlp: { rules: body.dlp.rules, keywords: [...new Set(body.dlp.keywords.filter(Boolean))] },
  };
  await saveOutboundPolicy(c.env.DB, next, c.get("user").id);
  // Which sections changed and the new modes; template and keyword text stay out of the log.
  await audit(c, {
    action: "settings.outbound_updated",
    targetType: "settings",
    meta: {
      signatureMode: { from: prev.signature.mode, to: next.signature.mode },
      signatureChanged: JSON.stringify(prev.signature) !== JSON.stringify(next.signature),
      disclaimer: { enabled: next.disclaimer.enabled, externalOnly: next.disclaimer.externalOnly, changed: prev.disclaimer.text !== next.disclaimer.text },
      dlp: Object.fromEntries(DLP_RULES.map(({ id }) => [id, `${next.dlp.rules[id].action}/${next.dlp.rules[id].scope}`])),
      keywords: next.dlp.keywords.length,
    },
  });
  return c.json({ policy: next });
});
