/**
 * A small SCIM filter parser and evaluator (RFC 7644 §3.4.2.2), hand-written so nothing the
 * identity provider sends ever reaches SQL. Filters are evaluated against SCIM resources in memory.
 * Supported: eq ne co sw ew pr, and / or / not, parentheses, value paths like
 * `emails[type eq "work"]` and the Okta/Entra form `emails[type eq "work"].value eq "x"`.
 */

export type ScimValue = string | number | boolean | null;
export type CompareOp = "eq" | "ne" | "co" | "sw" | "ew";

export type ScimFilter =
  | { op: "and" | "or"; left: ScimFilter; right: ScimFilter }
  | { op: "not"; expr: ScimFilter }
  | { op: "pr"; path: string }
  | { op: CompareOp; path: string; value: ScimValue }
  /** `attr[filter]`: some element of the multi-valued attribute matches. */
  | { op: "has"; path: string; filter: ScimFilter };

export class ScimFilterError extends Error {}

const MAX_LENGTH = 1000;
const MAX_DEPTH = 12;
const CORE_USER = "urn:ietf:params:scim:schemas:core:2.0:user:";
const COMPARE = new Set(["eq", "ne", "co", "sw", "ew"]);
/** Valid comparison operators we don't implement; rejected with a clear message. */
const UNSUPPORTED = new Set(["gt", "ge", "lt", "le"]);

type Token = { t: "(" | ")" | "[" | "]" } | { t: "str"; v: string } | { t: "word"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if ("()[]".includes(ch)) {
      out.push({ t: ch as "(" });
      i++;
    } else if (ch === '"') {
      // JSON string literal, escapes included.
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) throw new ScimFilterError("Unterminated string in filter");
      try {
        out.push({ t: "str", v: JSON.parse(src.slice(i, j + 1)) as string });
      } catch {
        throw new ScimFilterError("Invalid string in filter");
      }
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_:.$\-+]+/.exec(src.slice(i));
      if (!m) throw new ScimFilterError(`Unexpected character "${ch}" in filter`);
      out.push({ t: "word", v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

/** Lowercased attribute path with the core User schema URN stripped. */
export function normalizePath(path: string): string {
  const p = path.toLowerCase();
  return p.startsWith(CORE_USER) ? p.slice(CORE_USER.length) : p;
}

const PATH_RE = /^(urn:[a-z0-9:._-]+:)?[a-z$][a-z0-9_$-]*(\.[a-z$][a-z0-9_$-]*)?$/i;

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  parse(): ScimFilter {
    const f = this.or(0);
    if (this.pos < this.toks.length) throw new ScimFilterError("Unexpected text at the end of the filter");
    return f;
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private word(): string | null {
    const t = this.peek();
    return t?.t === "word" ? t.v.toLowerCase() : null;
  }
  private expect(t: "(" | ")" | "]") {
    if (this.peek()?.t !== t) throw new ScimFilterError(`Expected "${t}" in filter`);
    this.pos++;
  }

  private or(depth: number): ScimFilter {
    let left = this.and(depth);
    while (this.word() === "or") {
      this.pos++;
      left = { op: "or", left, right: this.and(depth) };
    }
    return left;
  }

  private and(depth: number): ScimFilter {
    let left = this.unary(depth);
    while (this.word() === "and") {
      this.pos++;
      left = { op: "and", left, right: this.unary(depth) };
    }
    return left;
  }

  private unary(depth: number): ScimFilter {
    if (depth > MAX_DEPTH) throw new ScimFilterError("Filter is nested too deeply");
    if (this.word() === "not") {
      this.pos++;
      this.expect("(");
      const expr = this.or(depth + 1);
      this.expect(")");
      return { op: "not", expr };
    }
    if (this.peek()?.t === "(") {
      this.pos++;
      const f = this.or(depth + 1);
      this.expect(")");
      return f;
    }
    return this.comparison(depth);
  }

  private path(): string {
    const t = this.peek();
    if (t?.t !== "word" || !PATH_RE.test(t.v)) throw new ScimFilterError("Expected an attribute name in filter");
    this.pos++;
    return normalizePath(t.v);
  }

  private comparison(depth: number): ScimFilter {
    const path = this.path();
    if (this.peek()?.t === "[") {
      this.pos++;
      const inner = this.or(depth + 1);
      this.expect("]");
      // Okta and Entra send `emails[type eq "work"].value eq "x"`; fold the trailing
      // comparison into the bracket so it applies to the same element.
      const sub = this.peek();
      if (sub?.t === "word" && /^\.[a-z$][a-z0-9_$-]*$/i.test(sub.v)) {
        this.pos++;
        const tail = this.compareTail(sub.v.slice(1).toLowerCase());
        return { op: "has", path, filter: { op: "and", left: inner, right: tail } };
      }
      return { op: "has", path, filter: inner };
    }
    return this.compareTail(path);
  }

  private compareTail(path: string): ScimFilter {
    const op = this.word();
    if (!op) throw new ScimFilterError("Expected an operator in filter");
    this.pos++;
    if (op === "pr") return { op: "pr", path };
    if (UNSUPPORTED.has(op)) throw new ScimFilterError(`The "${op}" operator isn't supported`);
    if (!COMPARE.has(op)) throw new ScimFilterError(`Unknown filter operator "${op}"`);
    const t = this.peek();
    let value: ScimValue;
    if (t?.t === "str") value = t.v;
    else if (t?.t === "word") {
      const w = t.v.toLowerCase();
      if (w === "true" || w === "false") value = w === "true";
      else if (w === "null") value = null;
      else if (/^-?\d+(\.\d+)?$/.test(w)) value = Number(w);
      else throw new ScimFilterError("Filter values must be quoted strings, numbers, true, false or null");
    } else throw new ScimFilterError("Expected a value in filter");
    this.pos++;
    return { op: op as CompareOp, path, value };
  }
}

export function parseScimFilter(src: string): ScimFilter {
  if (src.length > MAX_LENGTH) throw new ScimFilterError("Filter is too long");
  if (!src.trim()) throw new ScimFilterError("Filter is empty");
  return new Parser(tokenize(src)).parse();
}

/** Attributes whose string values compare case-sensitively (RFC 7643 caseExact). */
const CASE_EXACT = new Set(["id", "externalid"]);

function lookup(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const hit = Object.keys(obj).find((k) => k.toLowerCase() === key);
  return hit === undefined ? undefined : (obj as Record<string, unknown>)[hit];
}

/** Every value at a (possibly dotted) path; multi-valued attributes fan out. */
function valuesAt(resource: unknown, path: string): unknown[] {
  let cur: unknown[] = [resource];
  for (const part of path.split(".")) {
    cur = cur.flatMap((o) => {
      const v = lookup(o, part);
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    });
  }
  return cur;
}

function compare(op: CompareOp, actual: unknown, expected: ScimValue, caseExact: boolean): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    const a = caseExact ? actual : actual.toLowerCase();
    const e = caseExact ? expected : expected.toLowerCase();
    if (op === "eq") return a === e;
    if (op === "ne") return a !== e;
    if (op === "co") return a.includes(e);
    if (op === "sw") return a.startsWith(e);
    return a.endsWith(e);
  }
  if (op === "eq") return actual === expected;
  if (op === "ne") return actual !== expected;
  return false;
}

export function matchesFilter(resource: unknown, f: ScimFilter): boolean {
  switch (f.op) {
    case "and":
      return matchesFilter(resource, f.left) && matchesFilter(resource, f.right);
    case "or":
      return matchesFilter(resource, f.left) || matchesFilter(resource, f.right);
    case "not":
      return !matchesFilter(resource, f.expr);
    case "pr":
      return valuesAt(resource, f.path).some((v) => v !== null && v !== "" && !(Array.isArray(v) && !v.length));
    case "has":
      return valuesAt(resource, f.path).some((el) => matchesFilter(el, f.filter));
    default: {
      const values = valuesAt(resource, f.path);
      const exact = CASE_EXACT.has(f.path);
      // "ne" holds when no value equals; absent attributes count as not equal.
      if (f.op === "ne") return !values.some((v) => compare("eq", v, f.value, exact));
      return values.some((v) => compare(f.op as CompareOp, v, f.value, exact));
    }
  }
}
