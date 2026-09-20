import type { Brand } from "@shared/brand";
import { escapeHtml } from "./util";

/**
 * Branded layout for server-sent (transactional) email.
 * Built for email clients: table layout, inline styles, bulletproof buttons,
 * hidden preheader and a plain-text twin. Everything comes from brand settings.
 */
export interface EmailContent {
  subject: string;
  /** Inbox preview line (hidden in the body). */
  preheader: string;
  /** Small uppercase label above the headline, e.g. "Invitation" or "Security". */
  eyebrow: string;
  heading: string;
  /** Tone of the eyebrow chip: brand accent, or amber for security alerts. */
  tone?: "brand" | "alert";
  greeting?: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  /** Label/value rows shown in a details card (who, when, where). */
  details?: [string, string][];
  /** Muted safety note at the bottom, e.g. "Didn't request this?…" */
  note?: string;
  /** Grouped lists of linked items (e.g. unread mail per mailbox). Plain text; escaped when rendered. */
  groups?: { title: string; count: number; items: { label: string; sub?: string; url: string }[]; more?: number }[];
  /** An extra footer line with a link, e.g. how to turn this email off. */
  footer?: { text: string; linkLabel: string; url: string };
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Black or white text for a background color (WCAG relative luminance). */
export function textOn(hex: string): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "#ffffff";
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#111111" : "#ffffff";
}

const abs = (url: string, appUrl: string) => (url.startsWith("/") ? `${appUrl.replace(/\/$/, "")}${url}` : url);

export function renderEmail(brand: Brand, appUrl: string, c: EmailContent): { html: string; text: string } {
  const accent = HEX.test(brand.accentColor) ? brand.accentColor : "#4f46e5";
  const onAccent = textOn(accent);
  const font = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
  const e = escapeHtml;
  const logoUrl = brand.logoUrl && !brand.logoUrl.startsWith("data:") ? abs(brand.logoUrl, appUrl) : "";
  const art = `${appUrl.replace(/\/$/, "")}/email/envelope.png`;
  const chipBg = c.tone === "alert" ? "rgba(251,191,36,0.16)" : "rgba(255,255,255,0.12)";
  const chipFg = c.tone === "alert" ? "#fcd34d" : "#e4e4e7";

  const logo = logoUrl
    ? `<img src="${e(logoUrl)}" width="32" height="32" alt="${e(brand.companyName)}" style="display:block;border-radius:8px;border:0">`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="32" height="32" align="center" valign="middle" bgcolor="#ffffff" style="width:32px;height:32px;border-radius:8px;background:#ffffff;color:#0a0a0b;font:700 12px/32px ${font}">${e(brand.monogram)}</td></tr></table>`;

  const paragraphs = c.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font:400 15px/1.6 ${font};color:#3f3f46">${p}</p>`)
    .join("");

  const button = c.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 28px"><tr>
        <td align="center" bgcolor="${accent}" style="border-radius:10px;background:${accent};box-shadow:0 8px 20px -8px ${accent}">
          <a href="${e(c.cta.url)}" target="_blank" style="display:inline-block;padding:14px 26px;font:600 15px/1 ${font};color:${onAccent};text-decoration:none;border-radius:10px">${e(c.cta.label)} &rarr;</a>
        </td></tr></table>`
    : "";

  const details = c.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid #ececef;border-radius:12px;background:#fafafa">
        ${c.details
          .map(
            ([k, v], i) => `<tr>
          <td style="padding:12px 16px;${i ? "border-top:1px solid #ececef;" : ""}font:500 13px/1.4 ${font};color:#71717a;width:38%">${e(k)}</td>
          <td style="padding:12px 16px;${i ? "border-top:1px solid #ececef;" : ""}font:500 13px/1.4 ${font};color:#18181b;word-break:break-word">${e(v)}</td>
        </tr>`,
          )
          .join("")}
      </table>`
    : "";

  const groups = (c.groups ?? [])
    .map(
      (g) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #ececef;border-radius:12px">
        <tr><td style="padding:12px 16px;border-bottom:1px solid #ececef;background:#fafafa;border-radius:12px 12px 0 0;font:600 13px/1.4 ${font};color:#18181b">
          ${e(g.title)} <span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:${accent};color:${onAccent};font:600 11px/1.4 ${font}">${g.count}</span>
        </td></tr>
        ${g.items
          .map(
            (it, i) => `<tr><td style="padding:11px 16px;${i ? "border-top:1px solid #f1f1f3;" : ""}">
          <a href="${e(it.url)}" target="_blank" style="text-decoration:none;display:block">
            <span style="display:block;font:600 14px/1.4 ${font};color:#18181b">${e(it.label)}</span>
            ${it.sub ? `<span style="display:block;font:400 13px/1.45 ${font};color:#71717a">${e(it.sub)}</span>` : ""}
          </a>
        </td></tr>`,
          )
          .join("")}
        ${g.more ? `<tr><td style="padding:10px 16px;border-top:1px solid #f1f1f3;font:500 13px/1.4 ${font};color:#71717a">and ${g.more} more</td></tr>` : ""}
      </table>`,
    )
    .join("");

  const fallback = c.cta
    ? `<p style="margin:0 0 24px;font:400 12px/1.6 ${font};color:#a1a1aa">Button not working? Copy this link into your browser:<br>
        <a href="${e(c.cta.url)}" style="color:${accent};word-break:break-all;text-decoration:none">${e(c.cta.url)}</a></p>`
    : "";

  const note = c.note
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:14px 16px;border-radius:12px;background:#f4f4f5;font:400 13px/1.55 ${font};color:#52525b">&#128274;&nbsp; ${c.note}</td>
      </tr></table>`
    : "";

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${e(c.subject)}</title>
<style>
  @media (max-width:600px){ .container{width:100%!important} .px{padding-left:24px!important;padding-right:24px!important} .h1{font-size:26px!important} .art{display:none!important} }
  a{color:${accent}}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${e(c.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f4f5" style="background:#f4f4f5">
<tr><td align="center" style="padding:40px 12px">
  <table role="presentation" class="container" width="580" cellpadding="0" cellspacing="0" style="width:580px;max-width:580px">

    <!-- Hero -->
    <tr><td bgcolor="#0a0a0b" style="border-radius:20px 20px 0 0;background-color:#0a0a0b;background-image:radial-gradient(circle at 12% 0%, ${accent}80 0%, rgba(10,10,11,0) 55%),radial-gradient(circle at 100% 100%, ${accent}40 0%, rgba(10,10,11,0) 50%)">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="px" style="padding:28px 40px 0">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td valign="middle">${logo}</td>
            <td valign="middle" style="padding-left:10px;font:600 14px/1 ${font};color:#ffffff">${e(brand.companyName)}</td>
          </tr></table>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td class="px" valign="bottom" style="padding:36px 16px 36px 40px">
              <span style="display:inline-block;padding:5px 10px;border-radius:999px;background:${chipBg};font:600 11px/1 ${font};letter-spacing:.08em;text-transform:uppercase;color:${chipFg}">${e(c.eyebrow)}</span>
              <h1 class="h1" style="margin:14px 0 0;font:700 30px/1.15 ${font};letter-spacing:-.02em;color:#ffffff">${e(c.heading)}</h1>
            </td>
            <td class="art" width="170" valign="bottom" style="padding:16px 28px 20px 0">
              <img src="${e(art)}" width="150" height="112" alt="" style="display:block;border:0;width:150px;height:auto">
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>

    <!-- Body -->
    <tr><td class="px" bgcolor="#ffffff" style="padding:36px 40px 32px;background:#ffffff;border-radius:0 0 20px 20px">
      ${c.greeting ? `<p style="margin:0 0 16px;font:600 16px/1.5 ${font};color:#18181b">${e(c.greeting)}</p>` : ""}
      ${paragraphs}
      ${groups}
      ${button}
      ${details}
      ${fallback}
      ${note}
    </td></tr>

    <!-- Footer -->
    <tr><td align="center" style="padding:28px 24px 8px;font:400 12px/1.7 ${font};color:#a1a1aa">
      Sent by <strong style="color:#71717a">${e(brand.productName)}</strong> for ${e(brand.companyName)}.
      ${brand.supportEmail ? `<br>Questions? <a href="mailto:${e(brand.supportEmail)}" style="color:#71717a">${e(brand.supportEmail)}</a>` : ""}
      <br>${e(brand.footerText)}
      ${c.footer ? `<br><br>${e(c.footer.text)} <a href="${e(c.footer.url)}" style="color:#71717a">${e(c.footer.linkLabel)}</a>` : ""}
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;

  const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const text = [
    c.heading,
    "",
    c.greeting ?? "",
    ...c.paragraphs.map(strip),
    ...(c.groups ?? []).flatMap((g) => [
      "",
      `${g.title} (${g.count})`,
      ...g.items.map((it) => `- ${it.label}${it.sub ? ` — ${it.sub}` : ""}\n  ${it.url}`),
      ...(g.more ? [`  and ${g.more} more`] : []),
    ]),
    "",
    c.cta ? `${c.cta.label}: ${c.cta.url}` : "",
    ...(c.details ?? []).map(([k, v]) => `${k}: ${v}`),
    c.note ? `\n${strip(c.note)}` : "",
    "",
    `— ${brand.productName} · ${brand.companyName}`,
    c.footer ? `${c.footer.text} ${c.footer.linkLabel}: ${c.footer.url}` : "",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");

  return { html, text };
}
