import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySvix } from "../worker/lib/svix";
import { base32Decode, base32Encode, verifyTotp, _hotpForTests } from "../worker/lib/totp";
import { hashPassword, passwordProblem, verifyPassword } from "../worker/lib/password";
import { htmlToText, normalizeSubject, parseAddress, parseAddressList, formatAddress } from "../worker/lib/util";
import { ftsExpression, parseQuery } from "../worker/lib/search";
import { cleanForQuote, prefixSubject } from "../worker/lib/quote";
import { referencedIds } from "../worker/lib/messages";

const SECRET = "whsec_" + Buffer.from("test-secret-key-0123456789").toString("base64");
function sign(id: string, ts: string, body: string) {
  const key = Buffer.from(SECRET.slice(6), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

describe("webhook signatures", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"type":"email.delivered"}';
  it("accepts a valid signature", async () => {
    expect(await verifySvix(SECRET, { id: "m1", timestamp: ts, signature: sign("m1", ts, body) }, body)).toBe(true);
  });
  it("accepts when one of several signatures matches", async () => {
    expect(await verifySvix(SECRET, { id: "m1", timestamp: ts, signature: `v1,bogus ${sign("m1", ts, body)}` }, body)).toBe(true);
  });
  it("rejects a tampered body", async () => {
    expect(await verifySvix(SECRET, { id: "m1", timestamp: ts, signature: sign("m1", ts, body) }, body + " ")).toBe(false);
  });
  it("rejects stale timestamps (replay)", async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(await verifySvix(SECRET, { id: "m1", timestamp: old, signature: sign("m1", old, body) }, body)).toBe(false);
  });
  it("rejects missing headers", async () => {
    expect(await verifySvix(SECRET, { id: null, timestamp: ts, signature: "v1,x" }, body)).toBe(false);
  });
});

describe("TOTP", () => {
  it("base32 round-trips", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 99, 0, 7]);
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
  });
  it("matches the RFC 6238 SHA-1 test vector", async () => {
    // Secret "12345678901234567890", T=59s -> 94287082 (last 6 digits: 287082)
    const secret = new TextEncoder().encode("12345678901234567890");
    expect(await _hotpForTests(secret, 1)).toBe("287082");
    expect(await verifyTotp(base32Encode(secret), "287082", 59_000)).toBe(true);
    expect(await verifyTotp(base32Encode(secret), "000000", 59_000)).toBe(false);
  });
});

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("Correct-Horse1");
    expect(h.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await verifyPassword("Correct-Horse1", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
  it("enforces strength", () => {
    expect(passwordProblem("short")).toBeTruthy();
    expect(passwordProblem("alllowercaseletters")).toBeTruthy();
    expect(passwordProblem("Good-Enough-1")).toBeNull();
  });
});

describe("addresses", () => {
  it("parses names and plain addresses", () => {
    expect(parseAddress('"Doe, Jane" <Jane@Example.com>')).toEqual({ email: "jane@example.com", name: "Doe, Jane" });
    expect(parseAddress("bob@example.com")).toEqual({ email: "bob@example.com" });
    expect(parseAddress("not an email")).toBeNull();
  });
  it("splits lists without breaking quoted commas", () => {
    expect(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com').map((a) => a.email)).toEqual(["jane@x.com", "bob@y.com"]);
  });
  it("quotes display names that need it", () => {
    expect(formatAddress({ email: "a@b.co", name: "Doe, Jane" })).toBe('"Doe, Jane" <a@b.co>');
    expect(formatAddress({ email: "a@b.co", name: "Jane" })).toBe("Jane <a@b.co>");
  });
});

describe("text helpers", () => {
  it("converts html to text", () => {
    expect(htmlToText("<p>Hi&nbsp;<b>there</b></p><script>x()</script><p>Bye</p>")).toBe("Hi there\nBye");
  });
  it("normalizes reply subjects", () => {
    expect(normalizeSubject("RE: Fwd: re: Hello")).toBe("hello");
    expect(prefixSubject("Re: Hello", "Re")).toBe("Re: Hello");
    expect(prefixSubject("Hello", "Fwd")).toBe("Fwd: Hello");
  });
  it("extracts referenced message ids", () => {
    expect(referencedIds("<a@x>", "<b@x> <a@x>")).toEqual(["<a@x>", "<b@x>"]);
  });
  it("strips active content from quoted html", () => {
    const out = cleanForQuote('<html><body><p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">l</a></body></html>');
    expect(out).not.toMatch(/script|onclick|javascript:/i);
    expect(out).toContain("Hi");
  });
});

describe("search", () => {
  it("parses operators", () => {
    const p = parseQuery('from:alice subject:"q4 plan" has:attachment is:unread in:sent budget');
    expect(p.from).toEqual(["alice"]);
    expect(p.subject).toEqual(["q4 plan"]);
    expect(p.hasAttachment && p.unread).toBe(true);
    expect(p.folder).toBe("sent");
    expect(p.text).toEqual(["budget"]);
  });
  it("builds a safe FTS expression", () => {
    expect(ftsExpression(['bud"get', "q4"])).toBe('"budget"* AND "q4"*');
    expect(ftsExpression([])).toBeNull();
  });
});
