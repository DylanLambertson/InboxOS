import { describe, expect, it } from "vitest";
import { z } from "zod";
import { intersectMailboxes, mailboxAllowed } from "../worker/lib/apikeys";
import { plainToHtml } from "../worker/lib/api-send";
import { unsubscribeUrl, verifyUnsubscribe } from "../worker/lib/unsubscribe";
import { zRecipients } from "../worker/routes/api-v1";
import { mcpRoutes } from "../worker/routes/mcp";

const SECRET = "test-session-secret";

describe("unsubscribe links", () => {
  it("round-trips the address", async () => {
    const url = new URL(await unsubscribeUrl("https://mail.example.com/", SECRET, "Jo@Acme.com"));
    expect(url.pathname).toBe("/unsubscribe");
    expect(await verifyUnsubscribe(SECRET, url.searchParams.get("e")!, url.searchParams.get("t")!)).toBe("jo@acme.com");
  });
  it("rejects a link edited to point at someone else", async () => {
    const a = new URL(await unsubscribeUrl("https://m.x", SECRET, "a@x.com"));
    const b = new URL(await unsubscribeUrl("https://m.x", SECRET, "b@x.com"));
    expect(await verifyUnsubscribe(SECRET, b.searchParams.get("e")!, a.searchParams.get("t")!)).toBeNull();
    expect(await verifyUnsubscribe("other-secret", a.searchParams.get("e")!, a.searchParams.get("t")!)).toBeNull();
    expect(await verifyUnsubscribe(SECRET, undefined, "x")).toBeNull();
  });
});

describe("recipients", () => {
  it("accepts a plain string form", () => {
    expect(zRecipients.parse("Jo Rivera <jo@client.example>")).toEqual([{ email: "jo@client.example", name: "Jo Rivera" }]);
  });
  it("accepts lists, objects and quoted commas", () => {
    expect(zRecipients.parse('"Doe, Jane" <jane@x.com>, bob@y.com').map((a) => a.email)).toEqual(["jane@x.com", "bob@y.com"]);
    expect(zRecipients.parse([{ email: "A@B.co", name: "A" }, "c@d.co"])).toEqual([{ email: "a@b.co", name: "A" }, { email: "c@d.co" }]);
  });
  it("rejects invalid addresses", () => {
    expect(zRecipients.safeParse("not-an-email").success).toBe(false);
    expect(zRecipients.safeParse([{ email: "nope" }]).success).toBe(false);
  });
});

describe("plain text bodies", () => {
  it("makes paragraphs, escapes HTML and links URLs", () => {
    const html = plainToHtml("Hi Jo,\n\nSaw https://acme.com/blog.\nLine two <b>\n\nThanks");
    expect(html.match(/<p /g)).toHaveLength(3);
    expect(html).toContain('<a href="https://acme.com/blog">https://acme.com/blog</a>.');
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("<br>");
  });
});

describe("act-as mailbox scoping", () => {
  it("an unrestricted key narrows to exactly the user's mailboxes", () => {
    expect(intersectMailboxes([], ["mb_a", "mb_b"])).toEqual(["mb_a", "mb_b"]);
  });
  it("a restricted key keeps only the overlap with the user's mailboxes", () => {
    expect(intersectMailboxes(["mb_a", "mb_c"], ["mb_a", "mb_b"])).toEqual(["mb_a"]);
  });
  it("no overlap means no access", () => {
    expect(intersectMailboxes(["mb_x"], ["mb_a", "mb_b"])).toEqual([]);
    expect(intersectMailboxes(["mb_a"], [])).toEqual([]);
  });
  it("a read-only member can read a mailbox but not send from or change it", () => {
    const scope = { mailboxIds: ["mb_a", "mb_v"], writableMailboxIds: ["mb_a"], actor: { id: "u", email: "u@x" }, userId: "u" };
    const c = { get: () => scope } as unknown as Parameters<typeof mailboxAllowed>[0];
    expect(mailboxAllowed(c, "mb_v")).toBe(true);
    expect(mailboxAllowed(c, "mb_v", "write")).toBe(false);
    expect(mailboxAllowed(c, "mb_a", "write")).toBe(true);
    expect(mailboxAllowed(c, "mb_z")).toBe(false);
  });
});

describe("MCP endpoint", () => {
  it("requires an API key", async () => {
    const res = await mcpRoutes.request("/", { method: "POST", body: "{}" }, { DB: {} });
    expect(res.status).toBe(401);
  });
  it("only accepts POST", async () => {
    expect((await mcpRoutes.request("/", { method: "GET" })).status).toBe(405);
  });
  it("publishes JSON schemas for every tool", async () => {
    // toJSONSchema must handle transforms and defaults in input mode, or tools/list would throw at startup.
    const schema = z.toJSONSchema(z.object({ to: zRecipients.optional(), n: z.number().default(1) }), { io: "input" }) as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties)).toEqual(["to", "n"]);
    expect(schema.required ?? []).not.toContain("n");
  });
});
