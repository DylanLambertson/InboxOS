import type { Address } from "@shared/types";
import type { MailRule, RuleCondition, RuleField, RuleFolder } from "@shared/mail-rules";

/**
 * Pure mail-rule evaluation: no I/O, so it is unit-tested directly and shared by
 * ingest, "run on existing mail" and the dry-run preview.
 */

export interface RuleMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  /** Plain-text body. */
  text: string;
  hasAttachments: boolean;
  /** Bytes. */
  size: number;
  /** Header name → value; names are matched case-insensitively. */
  headers: Record<string, string>;
  /** Unknown counts as "not in contacts". */
  senderInContacts?: boolean;
}

export interface RuleOutcome {
  /** null = leave it where it is. */
  folder: RuleFolder | null;
  labelIds: string[];
  read: boolean;
  starred: boolean;
  important: boolean;
  /** Ids of the rules that matched, in evaluation order. */
  matched: string[];
}

type EvalRule = Pick<MailRule, "id" | "enabled" | "position" | "match" | "conditions" | "actions" | "stopProcessing">;

/** Wildcard matching walks text × pattern in the worst case, so long text is cut... */
const WILDCARD_TEXT_LIMIT = 2_000;
/** ...and all wildcard conditions on one message share a step budget, so no rule set can stall ingest. */
export const WILDCARD_STEP_BUDGET = 500_000;

/** Mutable step allowance shared by the wildcard checks for one message. */
export interface StepBudget {
  left: number;
}

/** Unicode-aware case folding: "STRASSE" ≡ "straße", "ΟΔΟΣ" ≡ "οδος". */
export function fold(s: string): string {
  return s.normalize("NFKC").toUpperCase().toLowerCase().replace(/ς/g, "σ");
}

/**
 * Anchored glob match with only `*` (any run) and `?` (one character). Iterative with
 * single-star backtracking, so it is O(text × pattern) at worst and never exponential;
 * users never get to supply a regex.
 */
export function wildcardMatch(text: string | string[], pattern: string, budget: StepBudget = { left: WILDCARD_STEP_BUDGET }): boolean {
  const t = typeof text === "string" ? Array.from(text) : text;
  const p = Array.from(pattern.replace(/\*+/g, "*"));
  let ti = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    // Out of budget counts as no match: a pathological pattern just stops matching.
    if (--budget.left < 0) return false;
    if (pi < p.length && p[pi] !== "*" && (p[pi] === "?" || p[pi] === t[ti])) {
      ti++;
      pi++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = ti;
    } else if (star !== -1) {
      pi = star + 1;
      ti = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

function addressCandidates(list: Address[]): string[] {
  const out: string[] = [];
  for (const a of list) {
    const email = a.email ?? "";
    const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";
    out.push(email);
    if (domain) out.push(domain, `@${domain}`);
    if (a.name) out.push(a.name);
  }
  return out;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return String(v);
  return null;
}

/** Folded strings a text condition is compared against, computed once per message. */
class Prepared {
  private cache = new Map<string, string[]>();
  private chars = new Map<string, string[][]>();
  constructor(
    readonly m: RuleMessage,
    readonly budget: StepBudget = { left: WILDCARD_STEP_BUDGET },
  ) {}

  /** Candidates as code-point arrays, cut for wildcard matching; cached like candidates(). */
  wildcardCandidates(field: RuleField, header?: string): string[][] {
    const key = field === "header" ? `header:${(header ?? "").toLowerCase()}` : field;
    let v = this.chars.get(key);
    if (!v) {
      v = this.candidates(field, header).map((s) => Array.from(s.length > WILDCARD_TEXT_LIMIT ? s.slice(0, WILDCARD_TEXT_LIMIT) : s));
      this.chars.set(key, v);
    }
    return v;
  }

  candidates(field: RuleField, header?: string): string[] {
    const key = field === "header" ? `header:${(header ?? "").toLowerCase()}` : field;
    let v = this.cache.get(key);
    if (!v) {
      v = this.raw(field, header).map(fold);
      this.cache.set(key, v);
    }
    return v;
  }

  private raw(field: RuleField, header?: string): string[] {
    const m = this.m;
    switch (field) {
      case "from":
        return addressCandidates([m.from]);
      case "to":
        return addressCandidates(m.to);
      case "cc":
        return addressCandidates(m.cc);
      case "recipient":
        return addressCandidates([...m.to, ...m.cc]);
      case "subject":
        return [m.subject ?? ""];
      case "body":
        return [m.text ?? ""];
      case "header": {
        const h = headerValue(m.headers ?? {}, header ?? "");
        return h == null ? [] : [h];
      }
      default:
        return [];
    }
  }
}

export function conditionMatches(c: RuleCondition, p: Prepared | RuleMessage): boolean {
  const prep = p instanceof Prepared ? p : new Prepared(p);
  const m = prep.m;
  switch (c.field) {
    case "has_attachment":
      return c.value === "no" ? !m.hasAttachments : !!m.hasAttachments;
    case "size_gt": {
      const kb = Number(c.value);
      return Number.isFinite(kb) && kb >= 0 && (m.size ?? 0) > kb * 1024;
    }
    case "sender_contact":
      return c.value === "not_in" ? !m.senderInContacts : !!m.senderInContacts;
  }
  const value = fold((c.value ?? "").trim());
  // An empty value would match everything; treat it as a broken condition instead.
  if (!value) return false;
  const cands = prep.candidates(c.field, c.header);
  switch (c.op ?? "contains") {
    case "contains":
      return cands.some((s) => s.includes(value));
    case "not_contains":
      return !cands.some((s) => s.includes(value));
    case "equals":
      return cands.some((s) => s.trim() === value);
    case "starts_with":
      return cands.some((s) => s.startsWith(value));
    case "ends_with":
      return cands.some((s) => s.trimEnd().endsWith(value));
    case "wildcard":
      return prep.wildcardCandidates(c.field, c.header).some((s) => wildcardMatch(s, value, prep.budget));
    default:
      return false;
  }
}

export function ruleMatches(rule: Pick<EvalRule, "match" | "conditions">, msg: RuleMessage | Prepared): boolean {
  const p = msg instanceof Prepared ? msg : new Prepared(msg);
  // A rule without conditions never fires: "apply to everything" must be explicit, not accidental.
  if (!rule.conditions.length) return false;
  return rule.match === "any" ? rule.conditions.some((c) => conditionMatches(c, p)) : rule.conditions.every((c) => conditionMatches(c, p));
}

/**
 * Run rules in position order and merge their actions. The first rule that moves the
 * message decides the folder (higher rules win); labels accumulate; a matching rule
 * with stopProcessing ends evaluation. Bulk callers pass one shared budget for the whole run.
 */
export function evaluateRules(msg: RuleMessage, rules: EvalRule[], budget?: StepBudget): RuleOutcome {
  const out: RuleOutcome = { folder: null, labelIds: [], read: false, starred: false, important: false, matched: [] };
  const p = new Prepared(msg, budget);
  const ordered = rules.map((r, i) => ({ r, i })).sort((a, b) => a.r.position - b.r.position || a.i - b.i);
  for (const { r } of ordered) {
    if (!r.enabled || !ruleMatches(r, p)) continue;
    out.matched.push(r.id);
    for (const a of r.actions) {
      if (a.type === "move") out.folder ??= a.folder;
      else if (a.type === "label") {
        if (a.labelId && !out.labelIds.includes(a.labelId)) out.labelIds.push(a.labelId);
      } else if (a.type === "read") out.read = true;
      else if (a.type === "star") out.starred = true;
      else if (a.type === "important") out.important = true;
    }
    if (r.stopProcessing) break;
  }
  return out;
}

/** Fields the given rules look at, so callers only load the data they need. */
export function fieldsUsed(rules: Pick<EvalRule, "enabled" | "conditions">[]): Set<RuleField> {
  const s = new Set<RuleField>();
  for (const r of rules) if (r.enabled) for (const c of r.conditions) s.add(c.field);
  return s;
}
