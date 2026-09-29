import { describe, expect, it } from "vitest";
import { DEFAULT_OUTBOUND, type OutboundPolicy } from "../shared/outbound";
import { cardNetwork, findCards, findIbans, findKeywords, findSecrets, findSsns, ibanValid, luhnValid, scanOutbound, ssnValid, summarizeFindings } from "../worker/lib/dlp";

describe("credit cards", () => {
  it("validates Luhn", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("378282246310005")).toBe(true);
  });

  it("knows card networks by prefix and length", () => {
    expect(cardNetwork("4242424242424242")).toBe("Visa");
    expect(cardNetwork("5555555555554444")).toBe("Mastercard");
    expect(cardNetwork("2223003122003222")).toBe("Mastercard");
    expect(cardNetwork("378282246310005")).toBe("Amex");
    expect(cardNetwork("6011111111111117")).toBe("Discover");
    expect(cardNetwork("1234567812345670")).toBeNull();
  });

  it("finds real card numbers in common formats and masks them", () => {
    expect(findCards("card 4242424242424242 thanks")).toEqual(["Visa card ending 4242"]);
    expect(findCards("4242 4242 4242 4242")).toEqual(["Visa card ending 4242"]);
    expect(findCards("5555-5555-5555-4444")).toEqual(["Mastercard card ending 4444"]);
    expect(findCards("Amex: 3782 822463 10005.")).toEqual(["Amex card ending 0005"]);
    expect(findCards("pay with 4111111111111111, exp 12/28")).toEqual(["Visa card ending 1111"]);
  });

  it("never returns the full number", () => {
    const out = findCards("4242424242424242").join(" ");
    expect(out).not.toContain("424242424242");
  });

  it("ignores numbers that fail Luhn", () => {
    expect(findCards("4242424242424241")).toEqual([]);
    expect(findCards("4242 4242 4242 4241")).toEqual([]);
  });

  it("ignores order numbers, phone numbers and timestamps", () => {
    expect(findCards("Order #1000234567891234 shipped")).toEqual([]);
    expect(findCards("Call +1 (415) 555-0134 or 415-555-0134")).toEqual([]);
    expect(findCards("+44 20 7946 0958")).toEqual([]);
    expect(findCards("created 1696166400000 at 2023-10-01T12:00:00Z")).toEqual([]);
    expect(findCards("tracking 9400111899223197428490")).toEqual([]);
    expect(findCards("ref ORD-4242424242424242")).toEqual([]);
    expect(findCards("invoice INV4242424242424242")).toEqual([]);
    expect(findCards("4444444444444444")).toEqual([]);
    expect(findCards("1.4242424242424242")).toEqual([]);
  });

  it("ignores digit runs with odd grouping or mixed separators", () => {
    // Luhn-valid Visa number written as an ID, not as a card.
    expect(findCards("42-424242-42424242")).toEqual([]);
    expect(findCards("4242 4242-4242 4242")).toEqual([]);
  });
});

describe("US SSNs", () => {
  it("applies issuance rules", () => {
    expect(ssnValid("536", "22", "1234")).toBe(true);
    expect(ssnValid("000", "22", "1234")).toBe(false);
    expect(ssnValid("666", "22", "1234")).toBe(false);
    expect(ssnValid("912", "22", "1234")).toBe(false);
    expect(ssnValid("536", "00", "1234")).toBe(false);
    expect(ssnValid("536", "22", "0000")).toBe(false);
    expect(ssnValid("078", "05", "1120")).toBe(false);
  });

  it("finds written SSNs", () => {
    expect(findSsns("SSN: 536-22-1234")).toEqual(["SSN ending 1234"]);
    expect(findSsns("536 22 1234")).toEqual(["SSN ending 1234"]);
  });

  it("ignores phone numbers, dates, zip+4 and bare 9-digit runs", () => {
    expect(findSsns("call 415-555-0134")).toEqual([]);
    expect(findSsns("on 2023-10-01")).toEqual([]);
    expect(findSsns("zip 94107-1234")).toEqual([]);
    expect(findSsns("id 536221234")).toEqual([]);
    expect(findSsns("536-22 1234")).toEqual([]);
    expect(findSsns("part 1536-22-1234")).toEqual([]);
    expect(findSsns("example 123-45-6789")).toEqual([]);
    expect(findSsns("10:536-22-1234")).toEqual([]);
  });
});

describe("IBANs", () => {
  it("validates country length and mod-97", () => {
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("FR1420041010050500013M02606")).toBe(true);
    expect(ibanValid("DE89370400440532013001")).toBe(false);
    expect(ibanValid("DE8937040044053201300")).toBe(false);
    expect(ibanValid("ZZ89370400440532013000")).toBe(false);
  });

  it("finds IBANs with and without spaces, followed by text", () => {
    expect(findIbans("IBAN DE89 3704 0044 0532 0130 00 please")).toEqual(["IBAN DE ending 3000"]);
    expect(findIbans("GB82WEST12345698765432")).toEqual(["IBAN GB ending 5432"]);
    expect(findIbans("pay to gb82 west 1234 5698 7654 32 OK")).toEqual(["IBAN GB ending 5432"]);
  });

  it("ignores lookalikes", () => {
    expect(findIbans("model AB12 3456 7890 1234 5678")).toEqual([]);
    expect(findIbans("SKU DE12345678901234567890")).toEqual([]);
  });
});

describe("secrets", () => {
  it("finds well-known key formats, masked", () => {
    const text = [
      "aws AKIAIOSFODNN7EXAMPLE",
      `stripe ${"sk_live_"}51HxYzAbCdEfGhIjKlMnOpQr`,
      `gh ${"ghp_"}${"a".repeat(36)}`,
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const found = findSecrets(text);
    expect(found).toContain("AWS access key ending MPLE");
    expect(found).toContain("Stripe secret key ending OpQr");
    expect(found).toContain("GitHub token ending aaaa");
    expect(found.filter((f) => f === "Private key block")).toHaveLength(2);
    expect(found.join(" ")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("ignores test keys, public keys and prose", () => {
    expect(findSecrets(`${"sk_test_"}51HxYzAbCdEfGhIjKlMnOpQr`)).toEqual([]);
    expect(findSecrets("-----BEGIN PUBLIC KEY-----")).toEqual([]);
    expect(findSecrets("AKIA is the prefix for AWS keys")).toEqual([]);
    expect(findSecrets("ghp_short")).toEqual([]);
  });
});

describe("custom keywords", () => {
  it("matches whole words and phrases, case-insensitively", () => {
    expect(findKeywords("Update on project falcon", ["Project Falcon"])).toEqual(['Keyword "Project Falcon"']);
    expect(findKeywords("Project\nFalcon", ["project falcon"])).toEqual(['Keyword "project falcon"']);
    expect(findKeywords("CONFIDENTIAL draft", ["confidential"])).toEqual(['Keyword "confidential"']);
  });

  it("does not match inside other words or treat keywords as regex", () => {
    expect(findKeywords("Let's start", ["art"])).toEqual([]);
    expect(findKeywords("nonconfidential", ["confidential"])).toEqual([]);
    expect(findKeywords("a+b", ["a.b"])).toEqual([]);
    expect(findKeywords("costs $5", ["$5"])).toEqual(['Keyword "$5"']);
    expect(findKeywords("anything", ["", "  "])).toEqual([]);
  });
});

describe("scanOutbound", () => {
  const policy = (patch: Partial<OutboundPolicy["dlp"]["rules"]>, keywords: string[] = []): OutboundPolicy["dlp"] => ({
    rules: { ...DEFAULT_OUTBOUND.dlp.rules, ...patch },
    keywords,
  });
  const base = { subject: "Hi", text: "", filenames: [] as string[], hasExternal: true };

  it("applies each rule's action", () => {
    const f = scanOutbound(policy({ card: { action: "block", scope: "all" }, ssn: { action: "warn", scope: "all" } }), {
      ...base,
      text: "ssn 536-22-1234 card 4242 4242 4242 4242",
    });
    expect(f.map((x) => [x.rule, x.action])).toEqual([
      ["card", "block"],
      ["ssn", "warn"],
    ]);
  });

  it("skips external-only rules when every recipient is internal", () => {
    const p = policy({ card: { action: "block", scope: "external" } });
    expect(scanOutbound(p, { ...base, text: "4242424242424242", hasExternal: false })).toEqual([]);
    expect(scanOutbound(p, { ...base, text: "4242424242424242", hasExternal: true })).toHaveLength(1);
  });

  it("skips rules that are off", () => {
    expect(scanOutbound(policy({ card: { action: "off", scope: "all" } }), { ...base, text: "4242424242424242" })).toEqual([]);
  });

  it("scans subject and attachment filenames", () => {
    const p = policy({ keyword: { action: "warn", scope: "all" } }, ["falcon"]);
    expect(scanOutbound(p, { ...base, subject: "Falcon budget" })).toHaveLength(1);
    expect(scanOutbound(p, { ...base, filenames: ["falcon-roadmap.pdf"] })).toHaveLength(1);
  });

  it("de-duplicates repeated values", () => {
    expect(scanOutbound(policy({}), { ...base, text: "4242424242424242 and again 4242 4242 4242 4242" })).toHaveLength(1);
  });

  it("stays quiet on an ordinary business email", () => {
    const text = `Hi Sam,\n\nYour order #100023456 (invoice INV-2024-00981) ships 2024-03-15.\nCall me at +1 (415) 555-0134 or 415.555.0134.\nTracking: 1Z999AA10123456784. Meeting at 10:30, room 4B.\nTotal: $1,234,567.89\n\nThanks`;
    expect(scanOutbound(policy({ iban: { action: "block", scope: "all" } }), { ...base, text })).toEqual([]);
  });

  it("summarizes per rule without values", () => {
    const f = scanOutbound(policy({}), { ...base, text: "4242424242424242 5555555555554444 536-22-1234" });
    expect(summarizeFindings(f)).toEqual({ card: 2, ssn: 1 });
  });
});
