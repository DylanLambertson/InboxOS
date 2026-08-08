/**
 * WHITE-LABEL DEFAULTS
 *
 * Everything customer-facing about the brand lives here. These values are the
 * defaults; admins can override any of them at runtime from
 * Admin → Branding (stored in the `settings` table), so a rebrand normally
 * needs no code change at all. To ship a different default brand, edit this
 * file and redeploy.
 */
export interface Brand {
  /** Company that owns the deployment, e.g. "Acme". */
  companyName: string;
  /** Name of the mail product shown in the UI and page title. */
  productName: string;
  /** Primary sending/receiving domain. New mailboxes default to this domain. */
  primaryDomain: string;
  /** Absolute URL or data: URI of a logo (square works best). Empty = monogram. */
  logoUrl: string;
  /** 1–3 letters shown when no logo is set. */
  monogram: string;
  /** Brand accent color (hex). Buttons, focus rings, unread markers. */
  accentColor: string;
  /** Corner radius scale: "none" | "sm" | "md" | "lg". */
  radius: "none" | "sm" | "md" | "lg";
  /** CSS font-family stack for the UI. */
  fontFamily: string;
  /** Optional Google Fonts family name to load, e.g. "Inter". Empty = none. */
  googleFont: string;
  /** Headline on the sign-in page. */
  loginHeadline: string;
  /** Sub-headline on the sign-in page. */
  loginTagline: string;
  /** Where users go for help. */
  supportEmail: string;
  /** Small footer text on auth pages. */
  footerText: string;
  /** Default display name for outgoing mail when a mailbox has none. */
  defaultFromName: string;
}

export const DEFAULT_BRAND: Brand = {
  companyName: "Acme",
  productName: "InboxOS",
  primaryDomain: "example.com",
  logoUrl: "",
  monogram: "LM",
  accentColor: "#4f46e5",
  radius: "md",
  fontFamily:
    '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  googleFont: "Inter",
  loginHeadline: "Welcome back",
  loginTagline: "Sign in to your team inbox.",
  supportEmail: "support@example.com",
  footerText: "© Acme",
  defaultFromName: "Acme",
};

/** Organization policies, editable from Admin → Settings. */
export interface OrgPolicy {
  /** Outbound quota per UTC day (Resend free plan: 100). 0 = unlimited. */
  dailySendLimit: number;
  /** Outbound quota per calendar month (Resend free plan: 3000). 0 = unlimited. */
  monthlySendLimit: number;
  /** Max total attachment size per message, in MB (Resend limit: 40). */
  maxAttachmentMb: number;
  /** Days before messages in Trash/Spam are permanently deleted. */
  trashRetentionDays: number;
  /** Days to keep delivery events and audit logs. 0 = forever. */
  logRetentionDays: number;
  /** Require every user to enable two-factor authentication. */
  require2fa: boolean;
  /** Allow Google sign-in (also needs GOOGLE_CLIENT_ID/SECRET secrets). */
  googleSsoEnabled: boolean;
  /** Only allow Google accounts from these domains (empty = any invited user). */
  googleAllowedDomains: string[];
  /** Create an account automatically for Google users in an allowed domain. */
  googleAutoProvision: boolean;
  /** Allow password sign-in. Disable to enforce SSO (owners can always use password). */
  passwordLoginEnabled: boolean;
  /** Mailbox that receives mail for unknown addresses at your domains. */
  catchAllMailboxId: string | null;
  /** Session length in days. */
  sessionDays: number;
  /** Track opens/clicks (must also be enabled on the domain in Resend). */
  trackingEnabled: boolean;
}

export const DEFAULT_POLICY: OrgPolicy = {
  dailySendLimit: 100,
  monthlySendLimit: 3000,
  maxAttachmentMb: 25,
  trashRetentionDays: 30,
  logRetentionDays: 180,
  require2fa: false,
  googleSsoEnabled: true,
  googleAllowedDomains: ["example.com"],
  googleAutoProvision: false,
  passwordLoginEnabled: true,
  catchAllMailboxId: null,
  sessionDays: 14,
  trackingEnabled: false,
};

/** Convert radius keyword to a CSS length. */
export function radiusValue(r: Brand["radius"]): string {
  return { none: "0px", sm: "6px", md: "10px", lg: "14px" }[r] ?? "10px";
}
