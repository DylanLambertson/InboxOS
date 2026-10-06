import { describe, expect, it, vi } from "vitest";
import { bindZone, fqdnFor, guessZone, hostInZone, purposeOf, quoteTxt, type ExpectedRecord } from "../shared/dns";
import {
  checkDmarc,
  checkDomainDns,
  compareRecord,
  existingMailWarning,
  expectedFromResend,
  lookup,
  mailProviderFor,
  normalizeTxt,
  parseDohAnswers,
  parseMx,
} from "../worker/lib/dns";
import { explainKeyError, looksLikeApiKey, parseDomain, parseWebhookList, ResendError } from "../worker/lib/resend";

const RESEND_DOMAIN = {
  object: "domain",
  id: "4dd369bc-aa82-4ff3-97de-514ae3000ee0",
  name: "Example.com",
  status: "pending",
  created_at: "2026-03-28 17:12:02.059593+00",
  region: "eu-west-1",
  capabilities: { sending: "enabled", receiving: "enabled" },
  records: [
    { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: "verified", value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC" },
    { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "not_started", value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 },
    { record: "SPF", name: "send", type: "TXT", ttl: "Auto", status: "not_started", value: "v=spf1 include:amazonses.com ~all" },
    { record: "Receiving", name: "@", type: "MX", ttl: "Auto", status: "pending", value: "inbound-smtp.eu-west-1.amazonaws.com", priority: 10 },
    { bogus: true },
  ],
};

describe("Resend response parsing", () => {
  it("normalizes a domain", () => {
    const d = parseDomain(RESEND_DOMAIN);
    expect(d).toMatchObject({ id: RESEND_DOMAIN.id, name: "example.com", status: "pending", region: "eu-west-1", sending: true, receiving: true });
    expect(d.records).toHaveLength(4);
    expect(d.records[1]).toMatchObject({ type: "MX", priority: 10 });
    expect(d.records[0].priority).toBeUndefined();
  });

  it("tolerates missing fields and rejects garbage", () => {
    const d = parseDomain({ id: "x", name: "a.com" });
    expect(d).toMatchObject({ status: "not_started", region: "us-east-1", receiving: false, records: [] });
    expect(() => parseDomain({ name: "a.com" })).toThrow(ResendError);
    expect(() => parseDomain(null)).toThrow(ResendError);
  });

  it("parses webhook lists", () => {
    const list = parseWebhookList({
      object: "list",
      data: [{ id: "w1", endpoint: "https://a/webhooks/resend", events: ["email.sent", 3], status: "enabled" }, { nope: 1 }],
    });
    expect(list).toEqual([{ id: "w1", endpoint: "https://a/webhooks/resend", events: ["email.sent"], status: "enabled" }]);
    expect(parseWebhookList("bad")).toEqual([]);
  });

  it("explains key problems", () => {
    expect(explainKeyError(new ResendError("This API key is restricted to only send emails.", 401, "restricted_api_key")).problem).toBe("sending_only");
    expect(explainKeyError(new ResendError("API key is invalid", 401, "validation_error")).problem).toBe("invalid");
    expect(explainKeyError(new ResendError("x", 502, "network_error")).problem).toBe("network");
    expect(explainKeyError(new ResendError("x", 503)).problem).toBe("network");
    expect(explainKeyError(new Error("x")).problem).toBe("unknown");
  });

  it("recognises API key shapes", () => {
    expect(looksLikeApiKey("re_123456789_abcdefghijkl")).toBe(true);
    expect(looksLikeApiKey("sk_live_123")).toBe(false);
    expect(looksLikeApiKey("re_ ab")).toBe(false);
  });
});

describe("record names", () => {
  it("builds fully qualified names", () => {
    expect(fqdnFor("send", "example.com")).toBe("send.example.com");
    expect(fqdnFor("@", "example.com")).toBe("example.com");
    expect(fqdnFor("", "example.com")).toBe("example.com");
    expect(fqdnFor("send.example.com.", "example.com")).toBe("send.example.com");
    // Names relative to the apex on a subdomain.
    expect(fqdnFor("send.mail", "mail.example.com")).toBe("send.mail.example.com");
    expect(fqdnFor("resend._domainkey.mail", "mail.example.com")).toBe("resend._domainkey.mail.example.com");
    expect(fqdnFor("mail", "mail.example.com")).toBe("mail.example.com");
    expect(fqdnFor("send", "mail.example.com")).toBe("send.mail.example.com");
  });

  it("gives hosts relative to the zone", () => {
    expect(guessZone("mail.example.com")).toBe("example.com");
    expect(guessZone("mail.example.co.uk")).toBe("example.co.uk");
    expect(hostInZone("send.mail.example.com", "example.com")).toBe("send.mail");
    expect(hostInZone("example.com", "example.com")).toBe("@");
  });

  it("classifies records", () => {
    expect(purposeOf("DKIM", "TXT", "p=x")).toBe("dkim");
    expect(purposeOf("SPF", "MX", "feedback-smtp")).toBe("bounce");
    expect(purposeOf("SPF", "TXT", "v=spf1")).toBe("spf");
    expect(purposeOf("Receiving", "MX", "inbound-smtp.us-east-1.amazonaws.com")).toBe("receiving");
    expect(purposeOf("", "MX", "inbound-smtp.us-east-1.amazonaws.com")).toBe("receiving");
    expect(purposeOf("Tracking", "CNAME", "links1.resend-dns.com")).toBe("tracking");
  });

  it("writes a BIND zone snippet", () => {
    const records = expectedFromResend("example.com", parseDomain(RESEND_DOMAIN).records);
    const zone = bindZone("example.com", records);
    expect(zone).toContain("send.example.com.\t3600\tIN\tMX\t10 feedback-smtp.eu-west-1.amazonses.com.");
    expect(zone).toContain('send.example.com.\t3600\tIN\tTXT\t"v=spf1 include:amazonses.com ~all"');
    expect(zone).toContain("example.com.\t3600\tIN\tMX\t10 inbound-smtp.eu-west-1.amazonaws.com.");
    expect(quoteTxt("a".repeat(300))).toBe(`"${"a".repeat(255)}" "${"a".repeat(45)}"`);
  });
});

describe("DNS parsing", () => {
  it("reads DoH answers", () => {
    const json = {
      Status: 0,
      Answer: [
        { name: "x.example.com", type: 5, data: "y.example.net." },
        { name: "y.example.net", type: 16, data: '"v=spf1 " "include:amazonses.com ~all"' },
      ],
    };
    expect(parseDohAnswers(json, "TXT")).toEqual(["v=spf1 include:amazonses.com ~all"]);
    expect(parseDohAnswers(json, "CNAME")).toEqual(["y.example.net."]);
    expect(parseDohAnswers({ Status: 3 }, "MX")).toEqual([]);
    expect(() => parseDohAnswers({ Status: 2 }, "MX")).toThrow();
  });

  it("normalizes TXT and MX data", () => {
    expect(normalizeTxt('"a\\"b" "c"')).toBe('a"bc');
    expect(normalizeTxt("plain")).toBe("plain");
    expect(parseMx("10 Inbound-SMTP.us-east-1.amazonaws.com.")).toEqual({ priority: 10, host: "inbound-smtp.us-east-1.amazonaws.com" });
    expect(parseMx("garbage")).toBeNull();
  });

  it("looks up through a fetcher", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ Status: 0, Answer: [{ name: "a", type: 15, data: "10 mx.a." }] })));
    expect(await lookup("a.com", "MX", fetcher)).toEqual(["10 mx.a."]);
    expect((fetcher.mock.calls[0] as unknown[])[0]).toContain("name=a.com&type=MX");
    await expect(lookup("a.com", "MX", async () => new Response("", { status: 500 }))).rejects.toThrow();
  });
});

describe("record comparison", () => {
  const exp = (over: Partial<ExpectedRecord>): ExpectedRecord => ({ purpose: "dkim", type: "TXT", name: "x", fqdn: "x.example.com", value: "", ...over });

  it("checks DKIM values exactly (ignoring spacing)", () => {
    const e = exp({ value: "p=ABC DEF" });
    expect(compareRecord(e, ["p=ABCDEF"]).state).toBe("found");
    expect(compareRecord(e, ["p=OTHER"]).state).toBe("mismatched");
    expect(compareRecord(e, []).state).toBe("missing");
  });

  it("checks SPF includes and duplicates", () => {
    const e = exp({ purpose: "spf", value: "v=spf1 include:amazonses.com ~all" });
    expect(compareRecord(e, ["v=spf1 include:_spf.google.com include:amazonses.com ~all"]).state).toBe("found");
    const missingInclude = compareRecord(e, ["v=spf1 include:_spf.google.com ~all", "google-site-verification=x"]);
    expect(missingInclude.state).toBe("mismatched");
    expect(missingInclude.note).toContain("amazonses.com");
    expect(compareRecord(e, ["v=spf1 a ~all", "v=spf1 include:amazonses.com ~all"]).note).toMatch(/more than one/);
    expect(compareRecord(e, ["something-else"]).state).toBe("missing");
  });

  it("checks MX hosts and receiving priority", () => {
    const bounce = exp({ purpose: "bounce", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 });
    expect(compareRecord(bounce, ["10 feedback-smtp.us-east-1.amazonses.com."]).state).toBe("found");
    expect(compareRecord(bounce, ["20 feedback-smtp.us-east-1.amazonses.com."]).note).toMatch(/Priority/);
    expect(compareRecord(bounce, ["10 other.example.net."]).state).toBe("mismatched");

    const recv = exp({ purpose: "receiving", type: "MX", value: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 });
    expect(compareRecord(recv, ["10 inbound-smtp.us-east-1.amazonaws.com."]).state).toBe("found");
    const competing = compareRecord(recv, ["10 inbound-smtp.us-east-1.amazonaws.com.", "1 aspmx.l.google.com."]);
    expect(competing.state).toBe("mismatched");
    expect(competing.note).toContain("aspmx.l.google.com");
    expect(compareRecord(recv, ["1 inbound-smtp.us-east-1.amazonaws.com.", "5 aspmx.l.google.com."]).state).toBe("found");
  });

  it("checks CNAMEs", () => {
    const e = exp({ purpose: "tracking", type: "CNAME", value: "links1.resend-dns.com" });
    expect(compareRecord(e, ["links1.resend-dns.com."]).state).toBe("found");
    expect(compareRecord(e, ["elsewhere.com."]).state).toBe("mismatched");
  });

  it("recommends DMARC", () => {
    expect(checkDmarc("example.com", []).state).toBe("missing");
    expect(checkDmarc("example.com", ["v=DMARC1; p=reject"]).state).toBe("found");
    expect(checkDmarc("example.com", ["v=DMARC1; p=none", "v=DMARC1; p=reject"]).state).toBe("mismatched");
    expect(checkDmarc("example.com", []).fqdn).toBe("_dmarc.example.com");
  });

  it("warns about existing mail services", () => {
    expect(mailProviderFor("ASPMX.L.GOOGLE.COM.")).toBe("Google Workspace");
    expect(mailProviderFor("example-com.mail.protection.outlook.com")).toBe("Microsoft 365");
    expect(mailProviderFor("mx.example.net")).toBeNull();
    const w = existingMailWarning("example.com", ["1 aspmx.l.google.com.", "10 inbound-smtp.us-east-1.amazonaws.com."], "example.com");
    expect(w.existingMx).toEqual([{ host: "aspmx.l.google.com", priority: 1, provider: "Google Workspace" }]);
    expect(w.mxWarning).toMatch(/Google Workspace/);
    expect(w.mxWarning).toMatch(/inbox\.example\.com/);
    expect(existingMailWarning("example.com", ["10 inbound-smtp.us-east-1.amazonaws.com."], "example.com").mxWarning).toBeNull();
  });
});

describe("full domain check", () => {
  it("combines lookups and marks failed lookups as unknown", async () => {
    const zone: Record<string, { type: number; data: string }[]> = {
      "TXT resend._domainkey.example.com": [{ type: 16, data: '"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC"' }],
      "TXT send.example.com": [{ type: 16, data: '"v=spf1 include:amazonses.com ~all"' }],
      "MX example.com": [{ type: 15, data: "1 aspmx.l.google.com." }],
    };
    const fetcher = async (url: string) => {
      const u = new URL(url);
      const key = `${u.searchParams.get("type")} ${u.searchParams.get("name")}`;
      if (key === "MX send.example.com") throw new Error("offline");
      return new Response(JSON.stringify({ Status: 0, Answer: (zone[key] ?? []).map((a) => ({ name: "", ...a })) }));
    };
    const report = await checkDomainDns("example.com", expectedFromResend("example.com", parseDomain(RESEND_DOMAIN).records), fetcher);
    const by = Object.fromEntries(report.records.map((r) => [`${r.purpose}`, r.state]));
    expect(by).toEqual({ dkim: "found", bounce: "unknown", spf: "found", receiving: "mismatched" });
    expect(report.dmarc.state).toBe("missing");
    expect(report.existingMx[0].provider).toBe("Google Workspace");
    expect(report.mxWarning).toBeTruthy();
  });
});
