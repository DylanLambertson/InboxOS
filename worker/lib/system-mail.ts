import type { Env } from "../env";
import { renderEmail, type EmailContent } from "./email-layout";
import { getResendApiKey } from "./provider-config";
import { resend } from "./resend";
import { getBrand } from "./settings";
import { newId, now } from "./util";

/**
 * Record a system email in the delivery log. Sent ones count toward the sending quota
 * (Resend counts them too) and appear in the Overview; later delivery webhooks attach
 * to them by provider id.
 */
export async function logSystemEmail(env: Env, e: { resendId: string | null; to: string; subject: string; category: string; error?: string }) {
  try {
    await env.DB.prepare(
      "INSERT INTO email_events (id, message_id, resend_id, type, recipient, detail, payload, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        newId(),
        e.resendId,
        e.error ? "failed" : "system",
        e.to,
        (e.error ? `System email (${e.category}) failed: ${e.error}` : `System email (${e.category}): ${e.subject}`).slice(0, 1000),
        JSON.stringify({ category: e.category, subject: e.subject }),
        now(),
      )
      .run();
  } catch (err) {
    console.error("could not log system email", err);
  }
}

/** Send a branded transactional email from no-reply@<primary domain>. Never throws. */
export async function sendSystemEmail(
  env: Env,
  to: string,
  content: EmailContent,
  category = "system",
  opts: { headers?: Record<string, string> } = {},
): Promise<boolean> {
  const brand = await getBrand(env.DB);
  const { html, text } = renderEmail(brand, env.APP_URL, content);
  try {
    const res = await resend.send(await getResendApiKey(env), {
      from: `${brand.productName} <no-reply@${brand.primaryDomain}>`,
      to: [to],
      subject: content.subject,
      html,
      text,
      ...(brand.supportEmail ? { reply_to: [brand.supportEmail] } : {}),
      tags: [{ name: "category", value: category }],
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    await logSystemEmail(env, { resendId: res.id, to, subject: content.subject, category });
    return true;
  } catch (err) {
    console.error("system email failed", category, err);
    await logSystemEmail(env, { resendId: null, to, subject: content.subject, category, error: err instanceof Error ? err.message : "Unknown error" });
    return false;
  }
}
