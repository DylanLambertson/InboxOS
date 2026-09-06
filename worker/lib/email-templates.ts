import type { Brand } from "@shared/brand";
import type { EmailContent } from "./email-layout";
import { escapeHtml as e } from "./util";

/** Where and when a security-relevant action happened (shown in alerts). */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  at?: Date;
}

export function describeDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const when = (d = new Date()) =>
  d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });

const hi = (name?: string | null) => (name?.trim() ? `Hi ${name.trim().split(/\s+/)[0]},` : "Hi there,");

function contextRows(ctx?: RequestContext): [string, string][] {
  if (!ctx) return [];
  return [
    ["When", when(ctx.at)],
    ["Device", describeDevice(ctx.userAgent)],
    ["IP address", ctx.ip ?? "Unknown"],
  ];
}

export const templates = {
  /** Account claim: someone was invited to the workspace. */
  invite(b: Brand, p: { name?: string; email: string; inviter: string; url: string; days: number }): EmailContent {
    return {
      subject: `${p.inviter} invited you to ${b.productName}`,
      preheader: `Join ${b.companyName}'s team inbox — your invite expires in ${p.days} days.`,
      eyebrow: "Invitation",
      heading: `You're invited to ${b.companyName}`,
      greeting: hi(p.name),
      paragraphs: [
        `<strong style="color:#18181b">${e(p.inviter)}</strong> has set up an account for you on <strong style="color:#18181b">${e(b.productName)}</strong>, your team's email workspace.`,
        "Claim your account to choose a password and start sending, receiving and sharing mail with your team.",
      ],
      cta: { label: "Claim your account", url: p.url },
      details: [
        ["Account", p.email],
        ["Invited by", p.inviter],
        ["Link expires", `In ${p.days} days`],
      ],
      note: "This invitation link is unique to you, so please don't forward it. If you weren't expecting this, you can safely ignore this email.",
    };
  },

  /** Password reset (requested by the user, or started by an administrator). */
  reset(b: Brand, p: { name?: string; url: string; expires: string; byAdmin?: string; ctx?: RequestContext }): EmailContent {
    return {
      subject: `Reset your ${b.productName} password`,
      preheader: `Use this link to choose a new password. It expires in ${p.expires}.`,
      eyebrow: "Password reset",
      heading: "Let's get you back in",
      greeting: hi(p.name),
      paragraphs: [
        p.byAdmin
          ? `An administrator (<strong style="color:#18181b">${e(p.byAdmin)}</strong>) started a password reset for your ${e(b.productName)} account.`
          : `We received a request to reset the password for your ${e(b.productName)} account.`,
        "Choose a new password using the button below. For your security, you'll be signed out of every other device once it's changed.",
      ],
      cta: { label: "Choose a new password", url: p.url },
      details: [["Link expires", `In ${p.expires}`], ...(p.byAdmin ? [] : contextRows(p.ctx))],
      note: "Didn't ask for this? You can ignore this email — your password won't change unless you use the link above.",
    };
  },

  /** Confirmation that a password was changed or reset. */
  passwordChanged(b: Brand, p: { name?: string; appUrl: string; ctx?: RequestContext }): EmailContent {
    return {
      subject: `Your ${b.productName} password was changed`,
      preheader: "Your password was just changed. If this was you, no action is needed.",
      eyebrow: "Security alert",
      tone: "alert",
      heading: "Your password was changed",
      greeting: hi(p.name),
      paragraphs: ["The password for your account was just changed. If this was you, there's nothing else to do."],
      details: contextRows(p.ctx),
      note: `<strong>Wasn't you?</strong> Reset your password right away from the sign-in page${b.supportEmail ? ` and contact <a href="mailto:${e(b.supportEmail)}" style="color:#52525b">${e(b.supportEmail)}</a>` : ""}.`,
      cta: { label: "Review account security", url: `${p.appUrl.replace(/\/$/, "")}/settings/security` },
    };
  },

  /** Two-factor authentication turned on or off. */
  twoFactor(b: Brand, p: { name?: string; enabled: boolean; appUrl: string; ctx?: RequestContext }): EmailContent {
    return {
      subject: p.enabled ? "Two-factor authentication is on" : "Two-factor authentication was turned off",
      preheader: p.enabled ? "Your account now needs a code from your authenticator app to sign in." : "Your account no longer requires a sign-in code.",
      eyebrow: "Security alert",
      tone: "alert",
      heading: p.enabled ? "Two-factor is now on" : "Two-factor was turned off",
      greeting: hi(p.name),
      paragraphs: [
        p.enabled
          ? "Nice — your account is now protected by two-factor authentication. You'll enter a code from your authenticator app each time you sign in. Keep your recovery codes somewhere safe."
          : "Two-factor authentication was just removed from your account, so signing in now only needs your password. We recommend turning it back on.",
      ],
      cta: { label: p.enabled ? "View security settings" : "Turn two-factor back on", url: `${p.appUrl.replace(/\/$/, "")}/settings/security` },
      details: contextRows(p.ctx),
      note: `Didn't make this change? Reset your password immediately${b.supportEmail ? ` and let <a href="mailto:${e(b.supportEmail)}" style="color:#52525b">${e(b.supportEmail)}</a> know` : ""}.`,
    };
  },

  /** Sent after an invite is claimed. */
  welcome(b: Brand, p: { name?: string; email: string; appUrl: string; mailboxes: string[] }): EmailContent {
    return {
      subject: `Welcome to ${b.productName}`,
      preheader: `Your account is ready. Here's how to get the most out of ${b.productName}.`,
      eyebrow: "Welcome aboard",
      heading: `Welcome to ${b.productName}`,
      greeting: hi(p.name),
      paragraphs: [
        `Your account is ready. ${p.mailboxes.length ? "You have access to the mailboxes below — switch between them in the sidebar, or read them all at once in <strong style=\"color:#18181b\">All inboxes</strong>." : "An administrator will give you access to mailboxes shortly."}`,
        `A few things worth knowing: press <strong style="color:#18181b">C</strong> to compose, <strong style="color:#18181b">/</strong> to search, and <strong style="color:#18181b">?</strong> for every keyboard shortcut. You can undo a send for a few seconds after hitting Send.`,
      ],
      cta: { label: `Open ${b.productName}`, url: p.appUrl },
      details: [["Signed in as", p.email], ...(p.mailboxes.length ? ([["Mailboxes", p.mailboxes.join(", ")]] as [string, string][]) : [])],
      note: "Tip: turn on two-factor authentication in Settings → Security to keep your account extra safe.",
    };
  },
};

export type TemplateName = keyof typeof templates;
