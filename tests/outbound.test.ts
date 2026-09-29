import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND } from "../shared/brand";
import { DEFAULT_OUTBOUND, isExternal, renderSignature, signatureBlock, withOutboundDefaults, type OutboundPolicy } from "../shared/outbound";
import { applyOutboundPolicy, cleanTemplateHtml, disclaimerHtml, hasDisclaimer, PolicyBlockedError, saveOutboundPolicy, type OutboundInput } from "../worker/lib/outbound";

const vars = { name: "Ana Ruiz", title: "Head of Ops", email: "ana@example.com", phone: "+1 415 555 0134", mailbox: "Ana", company: "Acme" };

describe("signature templates", () => {
  it("fills every variable", () => {
    const html = renderSignature("{{name}}|{{title}}|{{email}}|{{phone}}|{{mailbox}}|{{company}}", vars);
    expect(html).toBe("Ana Ruiz|Head of Ops|ana@example.com|+1 415 555 0134|Ana|Acme");
  });

  it("HTML-escapes variable values", () => {
    const html = renderSignature("<p>{{name}} — {{title}}</p>", { ...vars, name: '<img src=x onerror="alert(1)">', title: "R&D \"lead\"" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("R&amp;D &quot;lead&quot;");
  });

  it("leaves unknown placeholders alone and tolerates spaces", () => {
    expect(renderSignature("{{ name }} {{nope}}", vars)).toBe("Ana Ruiz {{nope}}");
  });

  it("drops lines for empty fields in the default template", () => {
    const html = renderSignature(DEFAULT_OUTBOUND.signature.template, { ...vars, title: "", phone: "" });
    expect(html).toContain("<strong>Ana Ruiz</strong><br>Acme</p>");
    expect(html).toContain(">ana@example.com</p>");
    expect(html).not.toMatch(/<br>\s*<br>/);
    expect(html).not.toContain("·");
  });

  it("drops a paragraph that ends up empty", () => {
    expect(renderSignature("<p>{{phone}}</p><p>{{name}}</p>", { ...vars, phone: "" })).toBe("<p>Ana Ruiz</p>");
  });
});

describe("template cleaning", () => {
  it("strips scripts, handlers and javascript: links but keeps formatting", () => {
    const out = cleanTemplateHtml(`<p style="color:red" onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="https://x.test/l.png" onerror=alert(1)>`);
    expect(out).toBe(`<p style="color:red">Hi</p><a href="#">x</a><img src="https://x.test/l.png">`);
  });
});

describe("recipients", () => {
  const domains = ["example.com", "example.org"];
  it("treats company domains and their subdomains as internal", () => {
    expect(isExternal("a@example.com", domains)).toBe(false);
    expect(isExternal("a@EXAMPLE.ORG", domains)).toBe(false);
    expect(isExternal("a@eu.example.com", domains)).toBe(false);
    expect(isExternal("a@gmail.com", domains)).toBe(true);
    expect(isExternal("a@notexample.com", domains)).toBe(true);
  });
});

describe("policy defaults", () => {
  it("fills missing sections and rules from defaults", () => {
    const p = withOutboundDefaults({ dlp: { rules: { card: { action: "block", scope: "external" } } } } as unknown as Partial<OutboundPolicy>);
    expect(p.dlp.rules.card).toEqual({ action: "block", scope: "external" });
    expect(p.dlp.rules.ssn).toEqual(DEFAULT_OUTBOUND.dlp.rules.ssn);
    expect(p.signature.mode).toBe("off");
    expect(p.dlp.keywords).toEqual([]);
  });
});

describe("disclaimer", () => {
  it("escapes the admin text and carries a marker", () => {
    const html = disclaimerHtml("Confidential <b>notice</b>\nLine 2");
    expect(html).toContain("Confidential &lt;b&gt;notice&lt;/b&gt;<br>Line 2");
    expect(hasDisclaimer(html)).toBe(true);
    expect(hasDisclaimer("<p>hello</p>")).toBe(false);
  });
});

// ---- applyOutboundPolicy with a tiny in-memory D1 stand-in -------------------

function fakeDb(policy: OutboundPolicy) {
  const audits: { action: string; meta: string }[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        async first() {
          if (sql.includes("FROM settings")) return { value: JSON.stringify(policy) };
          if (sql.includes("FROM users")) return { id: "u1", name: "Ana Ruiz", email: "ana@example.com", job_title: "Ops <lead>", phone: "" };
          if (sql.includes("FROM mailboxes")) return { address: "hello@example.com", display_name: "Hello" };
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO audit_logs")) audits.push({ action: String(args[3]), meta: String(args[5]) });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, audits };
}

const input = (patch: Partial<OutboundInput> = {}): OutboundInput => ({
  messageId: "m1",
  userId: "u1",
  mailboxId: "mb1",
  fromAddress: "hello@example.com",
  subject: "Hello",
  bodyHtml: "<p>Hi there</p>",
  quoteHtml: "",
  rawHtml: false,
  fromApi: false,
  recipients: [{ email: "client@example.com" }],
  filenames: [],
  ...patch,
});

async function run(policy: Partial<OutboundPolicy>, patch: Partial<OutboundInput> = {}) {
  const p = withOutboundDefaults(policy);
  const { db, audits } = fakeDb(p);
  // Reset the module cache so each case sees its own policy.
  await saveOutboundPolicy(db, p, "u1");
  return { result: await applyOutboundPolicy(db, DEFAULT_BRAND, input(patch)), audits };
}

describe("applyOutboundPolicy", () => {
  const disclaimer = { enabled: true, text: "This email is confidential.", externalOnly: true };

  it("appends the disclaimer for external recipients only", async () => {
    const ext = await run({ disclaimer });
    expect(ext.result.html).toContain("This email is confidential.");
    const int = await run({ disclaimer }, { recipients: [{ email: "bob@example.org" }] });
    expect(int.result.html).not.toContain("confidential");
    const all = await run({ disclaimer: { ...disclaimer, externalOnly: false } }, { recipients: [{ email: "bob@example.org" }] });
    expect(all.result.html).toContain("confidential");
  });

  it("does not add a second disclaimer when the quote already has one", async () => {
    const quote = `<blockquote><p>earlier</p>${disclaimerHtml("This email is confidential.")}</blockquote>`;
    const { result } = await run({ disclaimer }, { quoteHtml: quote });
    expect(result.html.match(/data-io-disclaimer/g)).toHaveLength(1);
  });

  it("can't be switched off by a marker in the sender's own body", async () => {
    const { result } = await run({ disclaimer }, { bodyHtml: `<p>${disclaimerHtml("fake")}</p>`, fromApi: true });
    expect(result.html).toContain("This email is confidential.");
  });

  it("adds the disclaimer to an explicit text part and inside a raw HTML document", async () => {
    const { result } = await run({ disclaimer }, { apiText: "Plain body", rawHtml: true, fromApi: true, bodyHtml: "<html><body><p>x</p></body></html>" });
    expect(result.text).toBe("Plain body\n\n--\nThis email is confidential.");
    expect(result.html).toMatch(/This email is confidential\.<\/div><\/body><\/html>$/);
  });

  it("refuses block findings and audits without the value", async () => {
    const dlp = { rules: { ...DEFAULT_OUTBOUND.dlp.rules, card: { action: "block" as const, scope: "all" as const } }, keywords: [] };
    const p = withOutboundDefaults({ dlp });
    const { db, audits } = fakeDb(p);
    await saveOutboundPolicy(db, p, "u1");
    await expect(applyOutboundPolicy(db, DEFAULT_BRAND, input({ bodyHtml: "<p>4242 4242 4242 4242</p>" }))).rejects.toBeInstanceOf(PolicyBlockedError);
    const blocked = audits.find((a) => a.action === "dlp.blocked")!;
    expect(blocked).toBeTruthy();
    expect(blocked.meta).toContain('"card":1');
    expect(blocked.meta).not.toContain("4242");
  });

  it("checks the quoted text and API text part too", async () => {
    const dlp = { rules: { ...DEFAULT_OUTBOUND.dlp.rules, ssn: { action: "block" as const, scope: "all" as const } }, keywords: [] };
    await expect(run({ dlp }, { quoteHtml: "<blockquote>536-22-1234</blockquote>" })).rejects.toBeInstanceOf(PolicyBlockedError);
    await expect(run({ dlp }, { apiText: "ssn 536-22-1234", fromApi: true })).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it("sends warn findings and logs them", async () => {
    const { result, audits } = await run({}, { bodyHtml: "<p>4242424242424242</p>" });
    expect(result.findings).toHaveLength(1);
    expect(audits.map((a) => a.action)).toEqual(["dlp.warned_sent"]);
  });

  it("adds the enforced company signature before the quote, escaped", async () => {
    const signature = { mode: "enforce" as const, template: "<p>{{name}} · {{title}}</p>", mailboxTemplates: {} };
    const { result } = await run({ signature }, { quoteHtml: "<blockquote>old</blockquote>" });
    expect(result.html).toBe(`<p>Hi there</p>${signatureBlock("<p>Ana Ruiz · Ops &lt;lead&gt;</p>")}<blockquote>old</blockquote>`);
  });

  it("uses the per-mailbox override and skips API messages", async () => {
    const signature = { mode: "enforce" as const, template: "<p>org</p>", mailboxTemplates: { mb1: "<p>{{mailbox}} team</p>" } };
    expect((await run({ signature })).result.html).toContain("Hello team");
    expect((await run({ signature }, { fromApi: true })).result.html).toBe("<p>Hi there</p>");
  });

  it("leaves suggested signatures to the client", async () => {
    const signature = { mode: "suggest" as const, template: "<p>{{name}}</p>", mailboxTemplates: {} };
    expect((await run({ signature })).result.html).toBe("<p>Hi there</p>");
  });
});
