import { describe, expect, it } from "vitest";
import type { MailRule, RuleAction, RuleCondition } from "../shared/mail-rules";
import { conditionMatches, evaluateRules, fieldsUsed, fold, ruleMatches, wildcardMatch, type RuleMessage } from "../worker/lib/rules-engine";

const msg = (over: Partial<RuleMessage> = {}): RuleMessage => ({
  from: { email: "Billing@Stripe.com", name: "Stripe Billing" },
  to: [{ email: "team@example.com", name: "Team" }],
  cc: [{ email: "finance@example.com" }],
  subject: "Your invoice #1042 is ready",
  text: "Hello,\nyour invoice for October is attached.\nThanks",
  hasAttachments: true,
  size: 250 * 1024,
  headers: { "List-Id": "<billing.stripe.com>", "X-Mailer": "Stripe" },
  ...over,
});

let seq = 0;
const rule = (conditions: RuleCondition[], actions: RuleAction[], over: Partial<MailRule> = {}): MailRule => ({
  id: `r${++seq}`,
  mailboxId: "mb",
  name: "rule",
  enabled: true,
  position: seq,
  match: "all",
  conditions,
  actions,
  stopProcessing: false,
  hits: 0,
  lastHitAt: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

const cond = (field: RuleCondition["field"], op: RuleCondition["op"], value: string, header?: string): RuleCondition => ({ field, op, value, header });
const is = (c: RuleCondition, m = msg()) => conditionMatches(c, m);

describe("wildcardMatch", () => {
  it("anchors and supports * and ?", () => {
    expect(wildcardMatch("invoice 1042", "invoice *")).toBe(true);
    expect(wildcardMatch("invoice 1042", "invoice ????")).toBe(true);
    expect(wildcardMatch("invoice 1042", "invoice ???")).toBe(false);
    expect(wildcardMatch("invoice 1042", "*42")).toBe(true);
    expect(wildcardMatch("invoice 1042", "1042")).toBe(false);
    expect(wildcardMatch("", "*")).toBe(true);
    expect(wildcardMatch("abc", "a*b*c*")).toBe(true);
    expect(wildcardMatch("a.c", "a.c")).toBe(true);
    expect(wildcardMatch("abc", "a.c")).toBe(false); // no regex semantics
    expect(wildcardMatch("a+b(c)", "a+b(*)")).toBe(true);
  });
  it("treats astral characters as one ?", () => {
    expect(wildcardMatch("hi 😀", "hi ?")).toBe(true);
  });
  it("stays fast on hostile patterns", () => {
    const text = "a".repeat(20_000);
    const start = Date.now();
    expect(wildcardMatch(text, `${"*a".repeat(50)}b`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

describe("fold", () => {
  it("folds unicode case", () => {
    expect(fold("STRASSE")).toBe(fold("straße"));
    expect(fold("ΟΔΟΣ")).toBe(fold("οδος"));
    expect(fold("ÉCOLE")).toBe("école");
    expect(fold("ﬁle")).toBe("file"); // NFKC ligature
  });
});

describe("conditions", () => {
  it("from matches address, domain and name", () => {
    expect(is(cond("from", "contains", "stripe"))).toBe(true);
    expect(is(cond("from", "equals", "billing@stripe.com"))).toBe(true);
    expect(is(cond("from", "equals", "stripe.com"))).toBe(true);
    expect(is(cond("from", "equals", "@STRIPE.COM"))).toBe(true);
    expect(is(cond("from", "starts_with", "stripe b"))).toBe(true);
    expect(is(cond("from", "ends_with", "@stripe.com"))).toBe(true);
    expect(is(cond("from", "wildcard", "*@stripe.???"))).toBe(true);
    expect(is(cond("from", "equals", "stripe"))).toBe(false);
  });
  it("does not contain is true only when no candidate contains it", () => {
    expect(is(cond("from", "not_contains", "paypal"))).toBe(true);
    expect(is(cond("from", "not_contains", "STRIPE"))).toBe(false);
    expect(is(cond("recipient", "not_contains", "finance"))).toBe(false);
  });
  it("to / cc / any recipient", () => {
    expect(is(cond("to", "contains", "team@"))).toBe(true);
    expect(is(cond("to", "contains", "finance"))).toBe(false);
    expect(is(cond("cc", "contains", "finance"))).toBe(true);
    expect(is(cond("recipient", "equals", "finance@example.com"))).toBe(true);
    expect(is(cond("recipient", "equals", "example.com"))).toBe(true);
  });
  it("subject and body, case-insensitive", () => {
    expect(is(cond("subject", "contains", "INVOICE"))).toBe(true);
    expect(is(cond("subject", "starts_with", "your invoice"))).toBe(true);
    expect(is(cond("subject", "ends_with", "READY"))).toBe(true);
    expect(is(cond("subject", "equals", "your invoice #1042 is ready"))).toBe(true);
    expect(is(cond("subject", "wildcard", "your invoice #* is ready"))).toBe(true);
    expect(is(cond("body", "contains", "october"))).toBe(true);
    expect(is(cond("body", "wildcard", "*october*"))).toBe(true);
    expect(is(cond("subject", "contains", "Straße"), msg({ subject: "STRASSE closed" }))).toBe(true);
  });
  it("headers by name, case-insensitive; missing header", () => {
    expect(is(cond("header", "contains", "billing.stripe", "list-id"))).toBe(true);
    expect(is(cond("header", "equals", "stripe", "X-MAILER"))).toBe(true);
    expect(is(cond("header", "contains", "x", "X-Missing"))).toBe(false);
    expect(is(cond("header", "not_contains", "x", "X-Missing"))).toBe(true);
    expect(is(cond("header", "contains", "x", ""))).toBe(false);
  });
  it("attachments, size and contacts", () => {
    expect(is({ field: "has_attachment", value: "yes" })).toBe(true);
    expect(is({ field: "has_attachment", value: "no" })).toBe(false);
    expect(is({ field: "has_attachment", value: "no" }, msg({ hasAttachments: false }))).toBe(true);
    expect(is({ field: "size_gt", value: "200" })).toBe(true);
    expect(is({ field: "size_gt", value: "250" })).toBe(false);
    expect(is({ field: "size_gt", value: "abc" })).toBe(false);
    expect(is({ field: "sender_contact", value: "in" })).toBe(false);
    expect(is({ field: "sender_contact", value: "not_in" })).toBe(true);
    expect(is({ field: "sender_contact", value: "in" }, msg({ senderInContacts: true }))).toBe(true);
  });
  it("is safe with missing fields and empty values", () => {
    const bare = msg({ from: { email: "" }, to: [], cc: [], subject: undefined as unknown as string, text: undefined as unknown as string, headers: undefined as unknown as Record<string, string> });
    expect(is(cond("subject", "contains", "x"), bare)).toBe(false);
    expect(is(cond("body", "contains", "x"), bare)).toBe(false);
    expect(is(cond("to", "not_contains", "x"), bare)).toBe(true);
    expect(is(cond("header", "contains", "x", "list-id"), bare)).toBe(false);
    expect(is(cond("subject", "contains", "  "))).toBe(false);
    expect(is(cond("subject", "not_contains", ""))).toBe(false);
  });
});

describe("rules", () => {
  it("all vs any", () => {
    const conds = [cond("from", "contains", "stripe"), cond("subject", "contains", "receipt")];
    expect(ruleMatches({ match: "all", conditions: conds }, msg())).toBe(false);
    expect(ruleMatches({ match: "any", conditions: conds }, msg())).toBe(true);
    expect(ruleMatches({ match: "any", conditions: [] }, msg())).toBe(false);
  });

  it("merges actions in position order; first move wins", () => {
    const a = rule([cond("from", "contains", "stripe")], [{ type: "label", labelId: "L1" }, { type: "move", folder: "archive" }], { position: 2 });
    const b = rule([cond("subject", "contains", "invoice")], [{ type: "move", folder: "trash" }, { type: "star" }, { type: "label", labelId: "L1" }], { position: 1 });
    const o = evaluateRules(msg(), [a, b]);
    expect(o.matched).toEqual([b.id, a.id]);
    expect(o.folder).toBe("trash");
    expect(o.labelIds).toEqual(["L1"]);
    expect(o.starred).toBe(true);
    expect(o.read).toBe(false);
  });

  it("stop processing ends evaluation", () => {
    const a = rule([cond("from", "contains", "stripe")], [{ type: "read" }], { stopProcessing: true });
    const b = rule([cond("from", "contains", "stripe")], [{ type: "move", folder: "spam" }, { type: "important" }]);
    const o = evaluateRules(msg(), [b, a].map((r) => r)); // input order doesn't matter, position does
    expect(o.matched).toEqual([a.id]);
    expect(o.read).toBe(true);
    expect(o.folder).toBeNull();
    expect(o.important).toBe(false);
  });

  it("skips disabled rules and non-matching stop rules", () => {
    const off = rule([cond("from", "contains", "stripe")], [{ type: "move", folder: "spam" }], { enabled: false });
    const miss = rule([cond("from", "contains", "paypal")], [{ type: "read" }], { stopProcessing: true });
    const hit = rule([cond("subject", "contains", "invoice")], [{ type: "important" }]);
    const o = evaluateRules(msg(), [off, miss, hit]);
    expect(o.matched).toEqual([hit.id]);
    expect(o.important).toBe(true);
    expect(o.folder).toBeNull();
  });

  it("nothing matches → no changes", () => {
    const o = evaluateRules(msg(), [rule([cond("subject", "contains", "zzz")], [{ type: "read" }])]);
    expect(o).toEqual({ folder: null, labelIds: [], read: false, starred: false, important: false, matched: [] });
  });

  it("reports fields used by enabled rules", () => {
    const used = fieldsUsed([rule([{ field: "sender_contact", value: "in" }], []), rule([cond("body", "contains", "x")], [], { enabled: false })]);
    expect([...used]).toEqual(["sender_contact"]);
  });
});
