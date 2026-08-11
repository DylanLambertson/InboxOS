import type { Env } from "../env";
import { resend } from "./resend";
import { getBrand } from "./settings";
import { escapeHtml } from "./util";

/** Branded transactional email (invites, password resets) sent from no-reply@<primary domain>. */
export async function sendSystemEmail(
  env: Env,
  opts: { to: string; subject: string; heading: string; body: string; ctaLabel: string; ctaUrl: string; footnote?: string },
): Promise<boolean> {
  const brand = await getBrand(env.DB);
  const accent = /^#[0-9a-f]{3,8}$/i.test(brand.accentColor) ? brand.accentColor : "#4f46e5";
  const logo = brand.logoUrl.startsWith("https://")
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="" width="36" height="36" style="border-radius:8px;display:block;margin-bottom:24px">`
    : `<div style="width:36px;height:36px;border-radius:8px;background:${accent};color:#fff;font-weight:600;font-size:14px;line-height:36px;text-align:center;margin-bottom:24px">${escapeHtml(brand.monogram)}</div>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:40px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px">
    ${logo}
    <h1 style="font-size:20px;margin:0 0 12px;color:#111827">${escapeHtml(opts.heading)}</h1>
    <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 24px">${escapeHtml(opts.body)}</p>
    <a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px">${escapeHtml(opts.ctaLabel)}</a>
    <p style="font-size:12px;line-height:1.6;color:#6b7280;margin:24px 0 0">${escapeHtml(opts.footnote ?? "If you weren't expecting this email, you can ignore it.")}</p>
  </div>
  <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:16px">${escapeHtml(brand.footerText)}</p>
</body></html>`;
  try {
    await resend.send(env.RESEND_API_KEY, {
      from: `${brand.productName} <no-reply@${brand.primaryDomain}>`,
      to: [opts.to],
      subject: opts.subject,
      html,
      text: `${opts.heading}\n\n${opts.body}\n\n${opts.ctaLabel}: ${opts.ctaUrl}`,
      tags: [{ name: "category", value: "system" }],
    });
    return true;
  } catch (err) {
    console.error("system email failed", err);
    return false;
  }
}
