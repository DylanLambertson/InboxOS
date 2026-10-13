import type { HealthCheck, HealthStatus } from "@shared/health";
import type { HealthSnapshot } from "./health-checks";
import { plural } from "./health-format";

// ---- Security --------------------------------------------------------------------

export function securityChecks(s: HealthSnapshot): HealthCheck[] {
  const x = s.security;
  const out: HealthCheck[] = [];
  out.push({
    id: "security.owners",
    area: "security",
    status: x.owners >= 2 ? "ok" : x.owners === 1 ? "warn" : "fail",
    title: x.owners >= 2 ? `${x.owners} owners` : x.owners === 1 ? "Only one owner" : "No active owner",
    detail: x.owners >= 2 ? "Someone else can step in if an owner is locked out." : "Add a second owner so the workspace isn't stuck if one person loses access.",
    fix: x.owners >= 2 ? undefined : { label: "Manage users", to: "/admin/users" },
  });

  const missing = Math.max(0, x.activeUsers - x.with2fa);
  out.push({
    id: "security.2fa",
    area: "security",
    status: missing === 0 ? "ok" : x.require2fa ? "info" : "warn",
    title: `Two-factor: ${x.with2fa} of ${x.activeUsers} people`,
    detail:
      missing === 0
        ? "Everyone has a passkey or authenticator app."
        : x.require2fa
          ? `Required by policy: ${plural(missing, "person", "people")} will be asked to set it up at their next sign-in.`
          : `${plural(missing, "person", "people")} ${missing === 1 ? "signs" : "sign"} in with just a password. Consider requiring two-factor.`,
    fix: missing && !x.require2fa ? { label: "Require 2FA", to: "/admin/settings" } : undefined,
  });

  if (x.adminsWithout2fa.length) {
    const names = x.adminsWithout2fa.slice(0, 3).join(", ") + (x.adminsWithout2fa.length > 3 ? ` and ${x.adminsWithout2fa.length - 3} more` : "");
    out.push({
      id: "security.admin2fa",
      area: "security",
      status: "warn",
      title: `${plural(x.adminsWithout2fa.length, "admin")} without two-factor`,
      detail: `${names} can change workspace settings with only a password.`,
      fix: { label: "Review admins", to: "/admin/users" },
    });
  }

  if (x.pendingInvites || x.expiredInvites) {
    out.push({
      id: "security.invites",
      area: "security",
      status: x.expiredInvites ? "warn" : "info",
      title: x.expiredInvites ? `${plural(x.expiredInvites, "invite")} expired` : `${plural(x.pendingInvites, "invite")} pending`,
      detail: x.expiredInvites ? "Resend or remove expired invites so they don't linger." : "Waiting for people to accept.",
      fix: { label: "Open users", to: "/admin/users" },
    });
  }

  if (x.ipAllowlist.length) {
    const openAll = x.ipAllowlist.some((c) => /^(0\.0\.0\.0\/0|::\/0)$/.test(c.trim()));
    const status: HealthStatus = openAll ? "warn" : x.requesterAllowed === false ? "warn" : "ok";
    out.push({
      id: "security.ipAllowlist",
      area: "security",
      status,
      title: openAll ? "IP allowlist allows everyone" : x.requesterAllowed === false ? "You're outside the IP allowlist" : "IP allowlist active",
      detail: openAll
        ? "A 0.0.0.0/0 or ::/0 entry lets every address in, so the list has no effect."
        : `${plural(x.ipAllowlist.length, "range")}, enforced for ${x.ipEnforceFor === "admins" ? "admins only" : "everyone"}.${x.requesterAllowed === false ? " Your current network isn't on it." : ""}`,
      fix: status === "ok" ? undefined : { label: "Edit allowlist", to: "/admin/security/access" },
    });
  }

  out.push(
    x.sessionSecretLength >= 32
      ? { id: "security.sessionSecret", area: "security", status: "ok", title: "Session secret is strong", detail: `${x.sessionSecretLength} characters.` }
      : {
          id: "security.sessionSecret",
          area: "security",
          status: "fail",
          title: x.sessionSecretLength ? "Session secret is too short" : "No session secret",
          detail: "Use at least 32 random characters: wrangler secret put SESSION_SECRET.",
        },
  );

  let appOrigin = "";
  try {
    appOrigin = new URL(x.appUrl).origin;
  } catch {
    /* invalid */
  }
  out.push(
    appOrigin && appOrigin === x.requestOrigin
      ? { id: "security.appUrl", area: "security", status: "ok", title: "App URL matches", detail: appOrigin }
      : {
          id: "security.appUrl",
          area: "security",
          status: "warn",
          title: appOrigin ? "App URL doesn't match this address" : "App URL isn't a valid URL",
          detail: `APP_URL is ${x.appUrl || "empty"} but you're using ${x.requestOrigin}. Links in emails, passkeys and Google sign-in use APP_URL.`,
        },
  );

  const googleSecrets = x.googleClientId && x.googleClientSecret;
  if (x.googleEnabled && !googleSecrets) {
    out.push({
      id: "security.google",
      area: "security",
      status: "warn",
      title: "Google sign-in is on but not configured",
      detail: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or turn Google sign-in off. The button is hidden until both are set.",
      fix: { label: "Sign-in policy", to: "/admin/settings" },
    });
  } else if (!x.googleEnabled && (x.googleClientId || x.googleClientSecret)) {
    out.push({
      id: "security.google",
      area: "security",
      status: "info",
      title: "Google sign-in is configured but off",
      detail: googleSecrets ? "Turn it on in Policies to let people sign in with Google." : "Only one of GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET is set.",
      fix: { label: "Sign-in policy", to: "/admin/settings" },
    });
  }

  if (x.pushFeature && !x.vapidKey) {
    out.push({
      id: "security.push",
      area: "security",
      status: "warn",
      title: "Push notifications have no key",
      detail: "Push is switched on, but VAPID_PRIVATE_JWK isn't set, so no notifications are sent.",
      fix: { label: "Features", to: "/admin/features" },
    });
  }
  return out;
}
