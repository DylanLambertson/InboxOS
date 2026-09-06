import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND } from "../shared/brand";
import { renderEmail, textOn } from "../worker/lib/email-layout";
import { describeDevice, templates } from "../worker/lib/email-templates";

const APP = "https://mail.example.com";

describe("system emails", () => {
  it("escapes user-controlled values", () => {
    const c = templates.invite(DEFAULT_BRAND, { name: "<img src=x onerror=alert(1)>", email: "a@b.co", inviter: '<script>alert("x")</script>', url: "https://x.test/i/abc", days: 7 });
    const { html } = renderEmail(DEFAULT_BRAND, APP, c);
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes the button, fallback link, preheader and brand", () => {
    const c = templates.reset(DEFAULT_BRAND, { name: "Dylan Lambertson", url: "https://x.test/reset/tok", expires: "1 hour", ctx: { ip: "1.2.3.4", userAgent: "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/140" } });
    const { html, text } = renderEmail(DEFAULT_BRAND, APP, c);
    expect(html.match(/https:\/\/x\.test\/reset\/tok/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Hi Dylan,");
    expect(html).toContain(DEFAULT_BRAND.companyName);
    expect(html).toContain(`${APP}/email/envelope.png`);
    expect(html).toContain("1.2.3.4");
    expect(text).toContain("Choose a new password: https://x.test/reset/tok");
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("makes relative logo URLs absolute", () => {
    const { html } = renderEmail({ ...DEFAULT_BRAND, logoUrl: "/api/brand/logo?v=1" }, APP, templates.welcome(DEFAULT_BRAND, { email: "a@b.co", appUrl: APP, mailboxes: [] }));
    expect(html).toContain(`${APP}/api/brand/logo?v=1`);
  });

  it("picks readable button text", () => {
    expect(textOn("#4f46e5")).toBe("#ffffff");
    expect(textOn("#fde047")).toBe("#111111");
  });

  it("describes devices", () => {
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1")).toBe("Safari on iOS");
    expect(describeDevice(null)).toBe("Unknown device");
  });
});
