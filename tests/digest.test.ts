import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND } from "../shared/brand";
import { addHours, buildDigestGroups, isDigestHours, maskEmail, personalEmailProblem, type DigestRow } from "../worker/lib/digest";
import { renderEmail } from "../worker/lib/email-layout";
import { templates } from "../worker/lib/email-templates";
import { digestOffUrl, unsubscribeUrl, verifyDigestOff } from "../worker/lib/unsubscribe";
import { renderUnsubscribePage } from "../worker/lib/unsubscribe-page";

const brand = { ...DEFAULT_BRAND, primaryDomain: "example.com", additionalDomains: ["example.org"] };
const SECRET = "test-secret-for-digests";

const row = (i: number, mailbox = "mb1", extra: Partial<DigestRow> = {}): DigestRow => ({
  id: `m${i}`,
  mailbox_id: mailbox,
  from_name: `Sender ${i}`,
  from_addr: `s${i}@x.com`,
  subject: `Subject ${i}`,
  mailbox_address: `${mailbox}@example.com`,
  mailbox_name: mailbox === "mb1" ? "Hello" : "Support",
  ...extra,
});

describe("personal email rules", () => {
  it("accepts an outside address", () => {
    expect(personalEmailProblem("me@gmail.com", "dylan@example.com", brand)).toBeNull();
  });
  it("refuses the sign-in email, company domains and junk", () => {
    expect(personalEmailProblem("Dylan@example.com", "dylan@example.com", brand)).toMatch(/sign-in/);
    expect(personalEmailProblem("me@example.org", "dylan@example.com", brand)).toMatch(/outside the company/);
    expect(personalEmailProblem("not an email", "dylan@example.com", brand)).toMatch(/valid/);
  });
  it("masks addresses for notices", () => {
    expect(maskEmail("jordan@gmail.com")).toBe("j****@gmail.com");
    expect(maskEmail("a@b.co")).toBe("a**@b.co");
  });
  it("knows the allowed frequencies", () => {
    expect([1, 3, 5, 12, 24].every(isDigestHours)).toBe(true);
    expect(isDigestHours(2)).toBe(false);
    expect(addHours("2026-10-01T00:00:00.000Z", 5)).toBe("2026-10-01T05:00:00.000Z");
  });
});

describe("digest grouping", () => {
  it("groups by mailbox, busiest first, with deep links", () => {
    const { groups, total } = buildDigestGroups([row(1), row(2, "mb2"), row(3)], new Map([["mb1", 2], ["mb2", 1]]), "https://mail.example/");
    expect(total).toBe(3);
    expect(groups.map((g) => g.mailbox)).toEqual(["Hello", "Support"]);
    expect(groups[0]!.items[0]!.url).toBe("https://mail.example/mail/mb1/inbox/m1");
  });
  it("lists at most 20 and counts the rest", () => {
    const rows = Array.from({ length: 21 }, (_, i) => row(i));
    const { groups } = buildDigestGroups(rows, new Map([["mb1", 35]]), "https://mail.example");
    expect(groups[0]!.items).toHaveLength(20);
    const email = templates.unreadDigest(brand, { name: "Dylan", total: 35, detail: "subjects", groups: groups.map((g) => ({ mailbox: g.mailbox, count: g.count, items: g.items })), openUrl: "https://x", offUrl: "https://off" });
    expect(email.groups![0]!.more).toBe(15);
    expect(email.subject).toBe("You have 35 unread emails in InboxOS");
  });
});

describe("digest email", () => {
  const hostile = { from: '<img src=x onerror=alert(1)>', subject: "<script>steal()</script>", url: "https://mail.example/mail/mb1/inbox/m1" };
  const make = (detail: "subjects" | "count") =>
    templates.unreadDigest(brand, { name: "Dylan", total: 1, detail, groups: [{ mailbox: "Hello", count: 1, items: [hostile] }], openUrl: "https://mail.example/mail/mb1/inbox", offUrl: "https://mail.example/api/digest/off?u=1&t=2" });

  it("escapes senders and subjects", () => {
    const { html } = renderEmail(brand, "https://mail.example", make("subjects"));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>steal");
    expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
  });
  it("count-only mode shows no senders or subjects", () => {
    const { html, text } = renderEmail(brand, "https://mail.example", make("count"));
    expect(html).not.toContain("steal");
    expect(text).not.toContain("steal");
    expect(text).toContain("Hello (1)");
  });
  it("has a plain-text twin with the links and the off switch", () => {
    const { text } = renderEmail(brand, "https://mail.example", make("subjects"));
    expect(text).toContain("https://mail.example/mail/mb1/inbox/m1");
    expect(text).toContain("Turn them off: https://mail.example/api/digest/off?u=1&t=2");
  });
});

describe("digest off links", () => {
  it("round-trips for the current address only", async () => {
    const url = new URL(await digestOffUrl("https://mail.example", SECRET, "user1", "Me@Gmail.com"));
    expect(url.pathname).toBe("/api/digest/off");
    expect(url.searchParams.has("e")).toBe(false); // the address isn't in the link
    const t = url.searchParams.get("t")!;
    expect(await verifyDigestOff(SECRET, "user1", "me@gmail.com", t)).toBe(true);
    expect(await verifyDigestOff(SECRET, "user2", "me@gmail.com", t)).toBe(false);
    expect(await verifyDigestOff(SECRET, "user1", "new@gmail.com", t)).toBe(false); // address changed
    expect(await verifyDigestOff(SECRET, "user1", null, t)).toBe(false);
    expect(await verifyDigestOff("other-secret", "user1", "me@gmail.com", t)).toBe(false);
  });
  it("an unsubscribe signature isn't accepted as a digest-off", async () => {
    const unsub = new URL(await unsubscribeUrl("https://mail.example", SECRET, "user1:me@gmail.com"));
    expect(await verifyDigestOff(SECRET, "user1", "me@gmail.com", unsub.searchParams.get("t")!)).toBe(false);
  });
});

describe("digest off pages", () => {
  it("asks first, then confirms, without scripts", () => {
    const ask = renderUnsubscribePage(brand, { kind: "digestConfirm", action: '/api/digest/off?u=1&t="><b>' });
    expect(ask).toContain("Turn off unread-mail reminders?");
    expect(ask).not.toContain('"><b>');
    expect(ask).not.toContain("<script");
    expect(renderUnsubscribePage(brand, { kind: "digestOff" })).toContain("Reminders are off");
  });
});
