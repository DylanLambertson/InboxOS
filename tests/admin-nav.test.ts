import { describe, expect, it } from "vitest";
import { ADMIN_NAV, featureForPath, findAdminNav, isConfigPath, visibleAdminNav } from "../src/lib/admin-nav";
import { FEATURE_KEYS, type FeatureFlags } from "../shared/workspace";

const allOn = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as FeatureFlags;
const paths = (groups: ReturnType<typeof visibleAdminNav>) => groups.flatMap((g) => g.items.map((i) => i.to));

describe("admin navigation", () => {
  it("has unique paths", () => {
    const all = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.to));
    expect(new Set(all).size).toBe(all.length);
  });

  it("hides configuration pages from managers but not from admins", () => {
    const manager = paths(visibleAdminNav("manager", allOn));
    for (const p of ["/admin/branding", "/admin/appearance", "/admin/features", "/admin/settings", "/admin/setup", "/admin/provisioning", "/admin/webhooks"]) {
      expect(manager).not.toContain(p);
      expect(paths(visibleAdminNav("admin", allOn))).toContain(p);
    }
    expect(manager).toContain("/admin/domains");
    expect(manager).toContain("/admin/health");
  });

  it("drops pages whose feature is off, and empty groups", () => {
    const off = { ...allOn, api: false, webhooks: false, compliance: false };
    const groups = visibleAdminNav("owner", off);
    expect(paths(groups)).not.toContain("/admin/api");
    expect(paths(groups)).not.toContain("/admin/compliance");
    expect(groups.find((g) => g.id === "developers")).toBeUndefined();
  });

  it("treats configuration sub-paths as configuration", () => {
    expect(isConfigPath("/admin/settings")).toBe(true);
    expect(isConfigPath("/admin/setup/")).toBe(true);
    expect(isConfigPath("/admin/webhooks/abc")).toBe(true);
    expect(isConfigPath("/admin/security/access")).toBe(false);
    expect(isConfigPath("/admin/settingsx")).toBe(false);
    expect(isConfigPath("/admin")).toBe(false);
  });

  it("finds the nav entry for breadcrumbs", () => {
    expect(findAdminNav("/admin")?.item.label).toBe("Dashboard");
    expect(findAdminNav("/admin/logs/audit")).toMatchObject({ group: { label: "Security & compliance" }, item: { label: "Audit log" } });
    expect(findAdminNav("/admin/logs")?.item.label).toBe("Delivery log");
    expect(findAdminNav("/admin/security/sessions")?.item.label).toBe("Security");
    expect(findAdminNav("/settings")).toBeNull();
  });

  it("knows which feature a page belongs to", () => {
    expect(featureForPath("/admin/traffic")).toBe("allTraffic");
    expect(featureForPath("/admin/users")).toBeUndefined();
  });
});
