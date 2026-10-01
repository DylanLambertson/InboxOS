import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND } from "../shared/brand";
import { reasonLabel, renderUnsubscribePage, UNSUBSCRIBE_CSP } from "../worker/lib/unsubscribe-page";

const brand = { ...DEFAULT_BRAND };

describe("unsubscribe page", () => {
  it("asks first, with optional reasons and a way to stay", () => {
    const html = renderUnsubscribePage(brand, { kind: "confirm", email: "pat@example.com", action: "/unsubscribe?e=a&t=b", stayUrl: "/unsubscribe?e=a&t=b&stay=1" });
    expect(html).toContain("Leaving so soon?");
    expect(html).toContain("pat@example.com");
    expect(html).toContain('name="reason" value="too_many"');
    expect(html).toContain("&amp;stay=1");
    expect(html).not.toContain("<script");
  });

  it("offers a resubscribe after unsubscribing", () => {
    const html = renderUnsubscribePage(brand, { kind: "done", email: "pat@example.com", resubscribeAction: "/unsubscribe?e=a&t=b&action=resubscribe" });
    expect(html).toContain("You're unsubscribed");
    expect(html).toContain("action=resubscribe");
  });

  it("escapes everything that comes from outside", () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const html = renderUnsubscribePage(
      { ...brand, companyName: evil, logoUrl: 'javascript:alert(1)"', theme: { ...brand.theme, accent: "red;}</style><script>" } },
      { kind: "confirm", email: evil, action: evil, stayUrl: evil },
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("</style><script>");
    expect(html).toContain("--accent:#4f46e5"); // a bad color falls back
  });

  it("maps reasons, and ignores unknown ones", () => {
    expect(reasonLabel("too_many")).toBe("Too many emails");
    expect(reasonLabel("<b>")).toBeUndefined();
  });

  it("is served with a script-free CSP", () => {
    expect(UNSUBSCRIBE_CSP).toContain("default-src 'none'");
    expect(UNSUBSCRIBE_CSP).not.toContain("script-src");
  });
});
