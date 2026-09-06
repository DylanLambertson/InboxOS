import type { Env } from "../env";
import { renderEmail, type EmailContent } from "./email-layout";
import { resend } from "./resend";
import { getBrand } from "./settings";

/** Send a branded transactional email from no-reply@<primary domain>. Never throws. */
export async function sendSystemEmail(env: Env, to: string, content: EmailContent, category = "system"): Promise<boolean> {
  const brand = await getBrand(env.DB);
  const { html, text } = renderEmail(brand, env.APP_URL, content);
  try {
    await resend.send(env.RESEND_API_KEY, {
      from: `${brand.productName} <no-reply@${brand.primaryDomain}>`,
      to: [to],
      subject: content.subject,
      html,
      text,
      ...(brand.supportEmail ? { reply_to: [brand.supportEmail] } : {}),
      tags: [{ name: "category", value: category }],
    });
    return true;
  } catch (err) {
    console.error("system email failed", category, err);
    return false;
  }
}
