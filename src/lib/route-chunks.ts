/**
 * Code-split pages. Each Settings and Admin page is its own chunk, loaded when
 * its route opens, or earlier when someone hovers or focuses a link to it.
 * The router and the navigation share these loaders so a prefetch is reused.
 */
import type { ComponentType } from "react";

export const pages = {
  login: () => import("../pages/Auth"),
  verifyEmail: () => import("../pages/VerifyEmail"),
  people: () => import("../pages/People"),
  setup: () => import("../pages/setup"),

  settingsLayout: () => import("../pages/settings/SettingsLayout"),
  settingsProfile: () => import("../pages/settings/Profile"),
  settingsMailboxes: () => import("../pages/settings/Mailboxes"),
  settingsSecurity: () => import("../pages/settings/Security"),
  settingsTemplates: () => import("../pages/settings/Templates"),
  settingsContacts: () => import("../pages/settings/Contacts"),

  adminLayout: () => import("../pages/admin/AdminLayout"),
  adminOverview: () => import("../pages/admin/Overview"),
  adminHealth: () => import("../pages/admin/Health"),
  adminTraffic: () => import("../pages/admin/Traffic"),
  adminUsers: () => import("../pages/admin/Users"),
  adminMailboxes: () => import("../pages/admin/Mailboxes"),
  adminBranding: () => import("../pages/admin/Branding"),
  adminAppearance: () => import("../pages/admin/Appearance"),
  adminFeatures: () => import("../pages/admin/Features"),
  adminPolicy: () => import("../pages/admin/Policy"),
  adminApiKeys: () => import("../pages/admin/ApiKeys"),
  adminProvisioning: () => import("../pages/admin/Provisioning"),
  adminUnsubscribes: () => import("../pages/admin/Unsubscribes"),
  adminSecurity: () => import("../pages/admin/Security"),
  adminCompliance: () => import("../pages/admin/Compliance"),
  adminOutbound: () => import("../pages/admin/OutboundPolicy"),
  adminLogs: () => import("../pages/admin/Logs"),
  adminSetup: () => import("../pages/admin/Setup"),
  adminDomains: () => import("../pages/admin/Domains"),
} satisfies Record<string, () => Promise<unknown>>;

/** A React Router `lazy` for one named export of a page module. */
export function routeLazy<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return async () => ({ Component: (await load())[name] as ComponentType });
}

/** Path prefixes and the chunk that renders them; the longest match wins. */
const BY_PATH: [string, () => Promise<unknown>][] = [
  ["/people", pages.people],
  ["/settings/profile", pages.settingsProfile],
  ["/settings/mailboxes", pages.settingsMailboxes],
  ["/settings/security", pages.settingsSecurity],
  ["/settings/templates", pages.settingsTemplates],
  ["/settings/contacts", pages.settingsContacts],
  ["/settings", pages.settingsLayout],
  ["/admin/health", pages.adminHealth],
  ["/admin/traffic", pages.adminTraffic],
  ["/admin/users", pages.adminUsers],
  ["/admin/mailboxes", pages.adminMailboxes],
  ["/admin/branding", pages.adminBranding],
  ["/admin/appearance", pages.adminAppearance],
  ["/admin/features", pages.adminFeatures],
  ["/admin/settings", pages.adminPolicy],
  ["/admin/api", pages.adminApiKeys],
  ["/admin/provisioning", pages.adminProvisioning],
  ["/admin/unsubscribes", pages.adminUnsubscribes],
  ["/admin/security", pages.adminSecurity],
  ["/admin/compliance", pages.adminCompliance],
  ["/admin/outbound", pages.adminOutbound],
  ["/admin/logs", pages.adminLogs],
  ["/admin/setup", pages.adminSetup],
  ["/admin/domains", pages.adminDomains],
  ["/admin", pages.adminOverview],
  ["/setup", pages.setup],
];

const warmed = new Set<string>();

/** Start loading the chunk for a path. Safe to call often; each chunk is requested once. */
export function prefetchRoute(to: string) {
  const path = to.split(/[?#]/)[0];
  const hit = BY_PATH.filter(([p]) => path === p || path.startsWith(`${p}/`)).sort((a, b) => b[0].length - a[0].length)[0];
  if (!hit || warmed.has(hit[0])) return;
  warmed.add(hit[0]);
  const loads = [hit[1]()];
  if (path.startsWith("/admin")) loads.push(pages.adminLayout());
  if (path.startsWith("/settings")) loads.push(pages.settingsLayout());
  // A failed prefetch is retried by the real navigation.
  Promise.all(loads).catch(() => warmed.delete(hit[0]));
}
