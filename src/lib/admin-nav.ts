/**
 * The admin console's navigation, shared by the sub-nav, breadcrumbs and the
 * command palette. Plain data plus pure helpers (unit-tested).
 */
import {
  Activity,
  Braces,
  Globe,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  MailX,
  Paintbrush,
  Palette,
  Radar,
  Rocket,
  Scale,
  ScrollText,
  ShieldCheck,
  Signature,
  SlidersHorizontal,
  ToggleRight,
  UserCog,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@shared/types";
import type { FeatureFlags, FeatureKey } from "@shared/workspace";

export interface AdminNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Only active on the exact path (the dashboard). */
  end?: boolean;
  /** Hidden while this feature is switched off (Admin → Features). */
  feature?: FeatureKey;
  /** A configuration page: owners and admins only; managers don't see it. */
  configOnly?: boolean;
  /** Extra words the command palette matches. */
  keywords?: string[];
}

export interface AdminNavGroup {
  id: string;
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { to: "/admin", label: "Dashboard", icon: LayoutDashboard, end: true, keywords: ["overview", "stats", "quota", "home"] },
      { to: "/admin/health", label: "Health", icon: HeartPulse, keywords: ["status", "checks", "diagnostics", "problems"] },
    ],
  },
  {
    id: "people",
    label: "People",
    items: [
      { to: "/admin/users", label: "Users", icon: Users, keywords: ["people", "members", "invite", "roles", "team"] },
      { to: "/admin/provisioning", label: "Provisioning", icon: UserCog, feature: "provisioning", configOnly: true, keywords: ["scim", "okta", "entra", "azure"] },
    ],
  },
  {
    id: "mail",
    label: "Mail",
    items: [
      { to: "/admin/mailboxes", label: "Mailboxes", icon: Inbox, keywords: ["shared inbox", "aliases", "addresses"] },
      { to: "/admin/domains", label: "Domains", icon: Globe, keywords: ["dns", "dkim", "spf", "dmarc", "verify"] },
      { to: "/admin/traffic", label: "All traffic", icon: Radar, feature: "allTraffic", keywords: ["unrouted", "every email"] },
      { to: "/admin/logs/delivery", label: "Delivery log", icon: Activity, keywords: ["bounces", "events", "delivered", "failed"] },
      { to: "/admin/unsubscribes", label: "Unsubscribes", icon: MailX, feature: "outreach", keywords: ["suppressions", "do not email", "opt out"] },
    ],
  },
  {
    id: "security",
    label: "Security & compliance",
    items: [
      { to: "/admin/security", label: "Security", icon: ShieldCheck, keywords: ["sessions", "sign-ins", "ip allowlist", "access"] },
      { to: "/admin/logs/audit", label: "Audit log", icon: ScrollText, keywords: ["history", "changes", "who"] },
      { to: "/admin/compliance", label: "Compliance", icon: Scale, feature: "compliance", keywords: ["retention", "legal hold", "ediscovery", "export"] },
      { to: "/admin/outbound", label: "Signatures & DLP", icon: Signature, feature: "outboundPolicy", keywords: ["disclaimer", "data loss"] },
      { to: "/admin/settings", label: "Policies", icon: SlidersHorizontal, configOnly: true, keywords: ["settings", "limits", "2fa", "google", "catch-all", "sso"] },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { to: "/admin/branding", label: "Branding", icon: Palette, configOnly: true, keywords: ["logo", "name", "company"] },
      { to: "/admin/appearance", label: "Appearance", icon: Paintbrush, configOnly: true, keywords: ["theme", "colors", "dark mode", "fonts"] },
      { to: "/admin/features", label: "Features", icon: ToggleRight, configOnly: true, keywords: ["switches", "use case", "turn on", "turn off"] },
      { to: "/admin/setup", label: "Setup", icon: Rocket, configOnly: true, keywords: ["wizard", "getting started", "provider", "resend"] },
    ],
  },
  {
    id: "developers",
    label: "Developers",
    items: [
      { to: "/admin/api", label: "API & MCP", icon: Braces, feature: "api", keywords: ["api keys", "tokens", "assistant", "integrations"] },
      { to: "/admin/webhooks", label: "Webhooks", icon: Webhook, feature: "webhooks", configOnly: true, keywords: ["events", "callbacks", "notify"] },
    ],
  },
];

const ALL_ITEMS = ADMIN_NAV.flatMap((g) => g.items.map((item) => ({ group: g, item })));
const within = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** The nav entry a path belongs to (longest match), for breadcrumbs and redirects. */
export function findAdminNav(pathname: string): { group: AdminNavGroup; item: AdminNavItem } | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  let best: { group: AdminNavGroup; item: AdminNavItem } | null = null;
  for (const hit of ALL_ITEMS) {
    const base = hit.item.to;
    const match = hit.item.end ? path === base : within(path, base);
    // /admin/logs/delivery and /admin/logs/audit share a page; match on the kind too.
    if (match && (!best || base.length > best.item.to.length)) best = hit;
  }
  if (!best && within(path, "/admin/logs")) return ALL_ITEMS.find((h) => h.item.to === "/admin/logs/delivery") ?? null;
  return best;
}

export const canManageRole = (role: Role | undefined) => role === "owner" || role === "admin";

/** Managers can't open configuration pages. */
export function isConfigPath(pathname: string): boolean {
  return ALL_ITEMS.some(({ item }) => item.configOnly && within(pathname.replace(/\/+$/, ""), item.to));
}

/** The feature a path depends on, if any. */
export function featureForPath(pathname: string): FeatureKey | undefined {
  return findAdminNav(pathname)?.item.feature;
}

/** Groups and items this person may see, with switched-off features removed. Empty groups drop out. */
export function visibleAdminNav(role: Role | undefined, features: FeatureFlags, nav: AdminNavGroup[] = ADMIN_NAV): AdminNavGroup[] {
  const manage = canManageRole(role);
  return nav
    .map((g) => ({ ...g, items: g.items.filter((i) => (!i.configOnly || manage) && (!i.feature || features[i.feature])) }))
    .filter((g) => g.items.length > 0);
}
