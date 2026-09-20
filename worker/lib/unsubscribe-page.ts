import type { Brand } from "@shared/brand";
import { escapeHtml } from "./util";

/**
 * The public unsubscribe page: branded, animated with CSS only (no script, so it
 * runs under a strict CSP), and it honours prefers-reduced-motion.
 */

export type UnsubscribeView =
  | { kind: "confirm"; email: string; action: string; stayUrl: string }
  | { kind: "done"; email: string; resubscribeAction: string; already?: boolean }
  | { kind: "stayed" }
  | { kind: "resubscribed"; email: string }
  | { kind: "invalid" }
  | { kind: "digestConfirm"; action: string }
  | { kind: "digestOff" };

/** Why people leave; the value is stored with the unsubscribe so the team can see it. */
export const UNSUBSCRIBE_REASONS = [
  { value: "too_many", label: "Too many emails" },
  { value: "not_relevant", label: "Not relevant to me" },
  { value: "never_signed_up", label: "I never signed up" },
  { value: "other", label: "Something else" },
] as const;

export const reasonLabel = (value: string | undefined) => UNSUBSCRIBE_REASONS.find((r) => r.value === value)?.label;

/** The CSP the page is served with: inline styles, our own form posts, images for the logo. */
export const UNSUBSCRIBE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const safeColor = (hex: string) => (/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#4f46e5");

/** Black or white text on a color, like the app's readableOn. */
function textOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.45 ? "#111111" : "#ffffff";
}

const ENVELOPE = `<svg class="art art--float" viewBox="0 0 120 96" aria-hidden="true">
  <rect x="10" y="18" width="100" height="66" rx="10" fill="var(--paper)" stroke="var(--accent)" stroke-width="3"/>
  <path d="M14 24l46 34 46-34" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <circle class="spark s1" cx="104" cy="14" r="4" fill="var(--accent)"/>
  <circle class="spark s2" cx="16" cy="10" r="3" fill="var(--accent)"/>
  <circle class="spark s3" cx="112" cy="58" r="2.5" fill="var(--accent)"/>
</svg>`;

const CHECK = `<svg class="art" viewBox="0 0 96 96" aria-hidden="true">
  <circle class="ring" cx="48" cy="48" r="40" fill="none" stroke="var(--accent)" stroke-width="5"/>
  <path class="tick" d="M30 49l12 12 25-27" fill="none" stroke="var(--accent)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const HEART = `<svg class="art art--pop" viewBox="0 0 96 96" aria-hidden="true">
  <path d="M48 80S14 60 14 36c0-11 8-19 18-19 7 0 12 4 16 10 4-6 9-10 16-10 10 0 18 8 18 19 0 24-34 44-34 44z" fill="var(--accent)"/>
  <circle class="spark s1" cx="84" cy="16" r="4" fill="var(--accent)"/>
  <circle class="spark s2" cx="10" cy="22" r="3" fill="var(--accent)"/>
</svg>`;

const WARN = `<svg class="art" viewBox="0 0 96 96" aria-hidden="true">
  <circle cx="48" cy="48" r="40" fill="none" stroke="var(--muted)" stroke-width="5"/>
  <path d="M48 28v26M48 66v1" stroke="var(--muted)" stroke-width="6" stroke-linecap="round"/>
</svg>`;

export function renderUnsubscribePage(brand: Brand, view: UnsubscribeView): string {
  const accent = safeColor(brand.accentColor);
  const company = escapeHtml(brand.companyName);
  const e = (s: string) => escapeHtml(s);
  const logo = brand.logoUrl
    ? `<img class="logo" src="${e(brand.logoUrl)}" alt="" width="40" height="40">`
    : `<span class="logo logo--mono">${e(brand.monogram)}</span>`;

  let title = "";
  let content = "";
  switch (view.kind) {
    case "confirm":
      title = `Unsubscribe from ${brand.companyName}`;
      content = `${ENVELOPE}
        <h1>Leaving so soon?</h1>
        <p>We'll stop sending emails from ${company} to</p>
        <p class="chip">${e(view.email)}</p>
        <form method="post" action="${e(view.action)}">
          <fieldset>
            <legend>Mind telling us why? <span>(optional)</span></legend>
            <div class="reasons">${UNSUBSCRIBE_REASONS.map(
              (r) => `<label class="reason"><input type="radio" name="reason" value="${r.value}"><span>${e(r.label)}</span></label>`,
            ).join("")}</div>
          </fieldset>
          <button class="btn btn--primary" type="submit">Unsubscribe</button>
        </form>
        <a class="link" href="${e(view.stayUrl)}">No, keep me subscribed</a>`;
      break;
    case "done":
      title = "You're unsubscribed";
      content = `${CHECK}
        <h1>${view.already ? "You're already unsubscribed" : "You're unsubscribed"}</h1>
        <p>${company} won't send outreach to <strong>${e(view.email)}</strong> again.</p>
        <p class="fine">Replies to conversations you start with us still reach you.</p>
        <form method="post" action="${e(view.resubscribeAction)}" class="again">
          <span>Changed your mind?</span>
          <button class="btn btn--ghost" type="submit">Resubscribe</button>
        </form>`;
      break;
    case "stayed":
      title = "Still subscribed";
      content = `${HEART}
        <h1>Glad you're staying!</h1>
        <p>Nothing changed. You'll keep hearing from ${company}.</p>`;
      break;
    case "resubscribed":
      title = "Welcome back";
      content = `${HEART}
        <h1>Welcome back!</h1>
        <p><strong>${e(view.email)}</strong> is subscribed to ${company} again.</p>`;
      break;
    case "digestConfirm":
      title = "Turn off reminders";
      content = `${ENVELOPE}
        <h1>Turn off unread-mail reminders?</h1>
        <p>You'll stop getting emails about unread mail in ${company}. Your mailbox itself isn't affected.</p>
        <form method="post" action="${e(view.action)}">
          <button class="btn btn--primary" type="submit">Turn off reminders</button>
        </form>`;
      break;
    case "digestOff":
      title = "Reminders off";
      content = `${CHECK}
        <h1>Reminders are off</h1>
        <p>You won't get unread-mail reminders anymore. Turn them back on any time in Settings → Profile.</p>`;
      break;
    case "invalid":
      title = "Link not valid";
      content = `${WARN}
        <h1>This link doesn't work</h1>
        <p>It may be incomplete or changed. Reply to any of our emails and ask us to stop, and we will.</p>
        ${brand.supportEmail ? `<p class="fine">Or write to <strong>${e(brand.supportEmail)}</strong>.</p>` : ""}`;
      break;
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${e(title)} · ${company}</title>
<style>
:root{--accent:${accent};--on-accent:${textOn(accent)};--bg:#f6f5f2;--paper:#ffffff;--ink:#14151a;--muted:#6b6f7b;--line:#e6e4de}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e11;--paper:#17171c;--ink:#f1f1f4;--muted:#9a9ca6;--line:#2a2a31}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--ink);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-x:hidden}
.orb{position:fixed;border-radius:50%;filter:blur(60px);opacity:.35;background:var(--accent);z-index:0;animation:drift 18s ease-in-out infinite alternate}
.orb.a{width:320px;height:320px;top:-80px;left:-60px}
.orb.b{width:260px;height:260px;bottom:-90px;right:-40px;opacity:.22;animation-duration:22s;animation-direction:alternate-reverse}
@keyframes drift{to{transform:translate(60px,40px) scale(1.15)}}
.card{position:relative;z-index:1;width:100%;max-width:440px;background:var(--paper);border:1px solid var(--line);border-radius:20px;
  padding:32px 28px 28px;text-align:center;box-shadow:0 30px 80px -30px rgba(0,0,0,.25);animation:rise .6s cubic-bezier(.2,.8,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(16px) scale(.98)}}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:18px;font-weight:600;font-size:14px;color:var(--muted)}
.logo{width:40px;height:40px;border-radius:10px;object-fit:contain}
.logo--mono{display:inline-grid;place-items:center;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:15px}
.art{width:112px;height:auto;margin:4px auto 10px;display:block;overflow:visible}
.art--float{animation:float 3.2s ease-in-out infinite}
@keyframes float{50%{transform:translateY(-8px) rotate(-2deg)}}
.art--pop{animation:pop .7s cubic-bezier(.2,1.6,.4,1) both}
@keyframes pop{from{transform:scale(.3);opacity:0}}
.spark{animation:twinkle 2.4s ease-in-out infinite}.s2{animation-delay:.6s}.s3{animation-delay:1.2s}
@keyframes twinkle{50%{opacity:.15;transform:scale(.6)}}
.spark{transform-box:fill-box;transform-origin:center}
.ring{stroke-dasharray:252;stroke-dashoffset:252;animation:draw .7s ease-out .1s forwards}
.tick{stroke-dasharray:60;stroke-dashoffset:60;animation:draw .45s ease-out .7s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
h1{font-size:23px;letter-spacing:-.01em;margin:6px 0 6px}
p{margin:0 0 6px;color:var(--muted)}
p strong{color:var(--ink);font-weight:600}
.fine{font-size:13px;margin-top:10px}
.chip{display:inline-block;margin:6px 0 4px;padding:6px 14px;border-radius:999px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--ink);font-weight:600;word-break:break-all}
fieldset{border:0;margin:18px 0 0;padding:0}
legend{font-size:13px;color:var(--muted);margin:0 auto 10px}
legend span{opacity:.7}
.reasons{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.reason input{position:absolute;opacity:0;pointer-events:none}
.reason span{display:inline-block;padding:7px 13px;border:1px solid var(--line);border-radius:999px;font-size:13px;cursor:pointer;transition:all .15s}
.reason span:hover{border-color:var(--accent)}
.reason input:checked+span{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.reason input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.btn{font:inherit;font-weight:600;border-radius:12px;cursor:pointer;transition:transform .12s,filter .12s}
.btn:active{transform:scale(.98)}
.btn--primary{width:100%;margin-top:20px;padding:13px 18px;border:0;background:var(--accent);color:var(--on-accent);box-shadow:0 10px 24px -10px var(--accent)}
.btn--primary:hover{filter:brightness(1.08)}
.btn--ghost{padding:8px 14px;border:1px solid var(--line);background:transparent;color:var(--ink)}
.btn--ghost:hover{border-color:var(--accent)}
.link{display:inline-block;margin-top:14px;font-size:14px;color:var(--muted);text-decoration:none}
.link:hover{color:var(--ink);text-decoration:underline}
.again{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:20px;padding-top:18px;border-top:1px solid var(--line);font-size:14px;color:var(--muted)}
footer{position:relative;z-index:1;margin-top:18px;font-size:12px;color:var(--muted);text-align:center}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.ring,.tick{stroke-dashoffset:0}}
</style></head>
<body><div class="orb a"></div><div class="orb b"></div>
<div><main class="card"><div class="brand">${logo}<span>${company}</span></div>${content}</main>
<footer>${e(brand.footerText || `© ${brand.companyName}`)}</footer></div>
</body></html>`;
}
