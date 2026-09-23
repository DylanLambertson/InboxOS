import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND, DEFAULT_POLICY } from "../shared/brand";
import { countryName, templates } from "../worker/lib/email-templates";
import { allowlistBlocks, allowlistLockoutProblem, ipAllowed, ipInCidr, isValidCidr, parseCidr, parseIp } from "../worker/lib/ip-allowlist";
import { newSignInReasons } from "../worker/lib/sign-ins";

describe("parseIp", () => {
  it("parses IPv4 into the IPv4-mapped range", () => {
    expect(parseIp("1.2.3.4")).toBe((0xffffn << 32n) | 0x01020304n);
    expect(parseIp("::ffff:1.2.3.4")).toBe(parseIp("1.2.3.4"));
    expect(parseIp("::ffff:0102:0304")).toBe(parseIp("1.2.3.4"));
    expect(parseIp("0.0.0.0")).toBe(0xffffn << 32n);
    expect(parseIp("255.255.255.255")).toBe((0xffffn << 32n) | 0xffffffffn);
  });

  it("parses IPv6 forms", () => {
    expect(parseIp("::")).toBe(0n);
    expect(parseIp("::1")).toBe(1n);
    expect(parseIp("2001:db8::1")).toBe(parseIp("2001:0db8:0000:0000:0000:0000:0000:0001"));
    expect(parseIp("2001:DB8::1")).toBe(parseIp("2001:db8::1"));
    expect(parseIp("1:2:3:4:5:6:7::")).toBe(parseIp("1:2:3:4:5:6:7:0"));
    expect(parseIp("::2:3:4:5:6:7:8")).toBe(parseIp("0:2:3:4:5:6:7:8"));
    expect(parseIp("64:ff9b::192.0.2.33")).toBe(parseIp("64:ff9b::c000:221"));
    expect(parseIp("1:2:3:4:5:6:1.2.3.4")).toBe(parseIp("1:2:3:4:5:6:102:304"));
    expect(parseIp(" 10.0.0.1 ")).toBe(parseIp("10.0.0.1"));
  });

  it("rejects invalid input", () => {
    for (const bad of [
      "",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "01.2.3.4",
      "1.2.3.-4",
      "a.b.c.d",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "1::2::3",
      ":::",
      ":1:2:3:4:5:6:7",
      "12345::",
      "g::1",
      "fe80::1%eth0",
      "[::1]",
      "::ffff:1.2.3",
      "::ffff:256.2.3.4",
      "1:2:3:4:5:6:7:1.2.3.4",
      "1.2.3.4::",
      "localhost",
      null,
      undefined,
    ])
      expect(parseIp(bad as string), String(bad)).toBeNull();
  });
});

describe("CIDR matching", () => {
  it("matches IPv4 ranges", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("192.168.1.255", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.2.0", "192.168.1.0/24")).toBe(false);
    expect(ipInCidr("203.0.113.7", "203.0.113.7/32")).toBe(true);
    expect(ipInCidr("203.0.113.8", "203.0.113.7/32")).toBe(false);
    expect(ipInCidr("203.0.113.7", "203.0.113.7")).toBe(true);
    // Host bits set in the range are ignored, like most firewalls.
    expect(ipInCidr("10.9.9.9", "10.1.2.3/8")).toBe(true);
  });

  it("treats /0 as everything in that family only", () => {
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("2001:db8::1", "0.0.0.0/0")).toBe(false);
    expect(ipInCidr("2001:db8::1", "::/0")).toBe(true);
    expect(ipInCidr("1.2.3.4", "::/0")).toBe(true);
  });

  it("matches IPv6 ranges", () => {
    expect(ipInCidr("2001:db8:abcd::1", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("2001:db8::1", "2001:db8::1/128")).toBe(true);
    expect(ipInCidr("2001:db8::2", "2001:db8::1/128")).toBe(false);
    expect(ipInCidr("2001:db8::ff", "2001:db8::/120")).toBe(true);
    expect(ipInCidr("2001:db8::1:0", "2001:db8::/120")).toBe(false);
  });

  it("treats IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(ipInCidr("::ffff:10.0.0.5", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("10.0.0.5", "::ffff:10.0.0.0/104")).toBe(true);
    expect(ipInCidr("10.0.0.5", "::ffff:0:0/96")).toBe(true);
    // A native IPv6 address that happens to share the low bits is not that IPv4 address.
    expect(ipInCidr("::a00:5", "10.0.0.0/8")).toBe(false);
  });

  it("never matches invalid input", () => {
    expect(ipInCidr("not-an-ip", "0.0.0.0/0")).toBe(false);
    expect(ipInCidr(null, "::/0")).toBe(false);
    expect(ipInCidr("1.2.3.4", "1.2.3.4/33")).toBe(false);
    expect(ipInCidr("::1", "::1/129")).toBe(false);
    expect(ipInCidr("1.2.3.4", "1.2.3.4/")).toBe(false);
    expect(ipInCidr("1.2.3.4", "1.2.3.4/08")).toBe(false);
    expect(ipInCidr("1.2.3.4", "1.2.3.4/-1")).toBe(false);
  });

  it("validates allowlist entries", () => {
    for (const ok of ["10.0.0.0/8", "203.0.113.7", "2001:db8::/32", "::1", "::/0", "0.0.0.0/0", "::ffff:1.2.3.4/128"]) expect(isValidCidr(ok), ok).toBe(true);
    for (const bad of ["", "10.0.0.0/33", "10.0.0/8", "2001:db8::/129", "example.com", "10.0.0.0/8/8", "1.2.3.4 /8"]) expect(isValidCidr(bad), bad).toBe(false);
    expect(parseCidr("10.0.0.0/8")?.prefix).toBe(104);
    expect(parseCidr("2001:db8::/32")?.prefix).toBe(32);
  });

  it("allows everything when the list is empty", () => {
    expect(ipAllowed("1.2.3.4", [])).toBe(true);
    expect(ipAllowed(null, [])).toBe(true);
    expect(ipAllowed("1.2.3.4", ["10.0.0.0/8", "1.2.3.0/24"])).toBe(true);
    expect(ipAllowed("1.2.4.4", ["10.0.0.0/8", "1.2.3.0/24"])).toBe(false);
    expect(ipAllowed(null, ["0.0.0.0/0"])).toBe(false);
  });
});

describe("allowlist enforcement", () => {
  const on = { ipAllowlist: ["10.0.0.0/8"], ipAllowlistEnforceFor: "everyone" as const };
  const admins = { ...on, ipAllowlistEnforceFor: "admins" as const };

  it("is off by default", () => {
    expect(DEFAULT_POLICY.ipAllowlist).toEqual([]);
    expect(allowlistBlocks(DEFAULT_POLICY, "1.2.3.4", "owner")).toBe(false);
  });

  it("blocks everyone outside the list, including owners", () => {
    expect(allowlistBlocks(on, "1.2.3.4", "member")).toBe(true);
    expect(allowlistBlocks(on, "1.2.3.4", "owner")).toBe(true);
    expect(allowlistBlocks(on, "1.2.3.4")).toBe(true);
    expect(allowlistBlocks(on, "10.2.3.4", "owner")).toBe(false);
    expect(allowlistBlocks(on, null, "member")).toBe(true);
  });

  it("only blocks console roles in admins mode, and never before the account is known", () => {
    expect(allowlistBlocks(admins, "1.2.3.4", "member")).toBe(false);
    expect(allowlistBlocks(admins, "1.2.3.4")).toBe(false);
    for (const r of ["owner", "admin", "manager"] as const) expect(allowlistBlocks(admins, "1.2.3.4", r)).toBe(true);
    expect(allowlistBlocks(admins, "10.0.0.1", "admin")).toBe(false);
  });

  it("refuses an allowlist that would lock out the admin saving it", () => {
    expect(allowlistLockoutProblem("1.2.3.4", [])).toBeNull();
    expect(allowlistLockoutProblem("10.0.0.9", ["10.0.0.0/8"])).toBeNull();
    expect(allowlistLockoutProblem("1.2.3.4", ["10.0.0.0/8"])).toMatch(/1\.2\.3\.4.*lock you out/);
    expect(allowlistLockoutProblem(null, ["10.0.0.0/8"])).toMatch(/unknown/);
  });
});

describe("new sign-in alerts", () => {
  const mac = { country: "US", device: "Chrome on macOS" };

  it("never alerts on the first sign-in ever", () => {
    expect(newSignInReasons(mac, [], false)).toEqual([]);
  });

  it("stays quiet for a known country and device", () => {
    expect(newSignInReasons(mac, [mac, { country: "CA", device: "Safari on iOS" }], true)).toEqual([]);
    // Known country and known device from different sign-ins is still familiar.
    expect(newSignInReasons(mac, [{ country: "US", device: "Safari on iOS" }, { country: "CA", device: "Chrome on macOS" }], true)).toEqual([]);
  });

  it("flags a new country, a new device, or both", () => {
    expect(newSignInReasons({ country: "DE", device: "Chrome on macOS" }, [mac], true)).toEqual(["country"]);
    expect(newSignInReasons({ country: "US", device: "Firefox on Windows" }, [mac], true)).toEqual(["device"]);
    expect(newSignInReasons({ country: "DE", device: "Firefox on Windows" }, [mac], true)).toEqual(["country", "device"]);
  });

  it("treats a long-dormant account's sign-in as new", () => {
    expect(newSignInReasons(mac, [], true)).toEqual(["country", "device"]);
  });

  it("doesn't flag the country when it's unknown", () => {
    expect(newSignInReasons({ country: null, device: "Chrome on macOS" }, [mac], true)).toEqual([]);
  });

  it("renders the alert email with device, place, IP and what to do", () => {
    const mail = templates.newSignIn(DEFAULT_BRAND, {
      name: "Sam Rivera",
      reasons: ["country"],
      device: "Chrome on Windows",
      country: "DE",
      appUrl: "https://mail.example.com/",
      ctx: { ip: "203.0.113.7", userAgent: null, at: new Date("2026-01-02T03:04:00Z") },
    });
    expect(mail.subject).toContain("New sign-in");
    expect(mail.heading).toContain("new location");
    const details = Object.fromEntries(mail.details ?? []);
    expect(details.Device).toBe("Chrome on Windows");
    expect(details["IP address"]).toBe("203.0.113.7");
    expect(details.Location).toContain("DE");
    expect(details.When).toContain("2026");
    expect(mail.note).toMatch(/change your password/i);
    expect(mail.cta?.url).toBe("https://mail.example.com/settings/security");
  });

  it("names countries", () => {
    expect(countryName("DE")).toBe("Germany (DE)");
    expect(countryName("T1")).toBe("Tor network");
  });
});
