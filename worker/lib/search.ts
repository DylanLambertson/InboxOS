import { FOLDERS, type Folder } from "@shared/types";

/**
 * Gmail-style search syntax:
 *   from:alice  to:bob  subject:invoice  has:attachment  is:unread  is:starred
 *   in:sent  label:clients  before:2026-01-31  after:2026-01-01  "exact phrase"  free words
 */
export interface ParsedQuery {
  text: string[];
  from: string[];
  to: string[];
  subject: string[];
  hasAttachment: boolean;
  unread: boolean;
  read: boolean;
  starred: boolean;
  folder: Folder | null;
  label: string | null;
  before: string | null;
  after: string | null;
}

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = {
    text: [],
    from: [],
    to: [],
    subject: [],
    hasAttachment: false,
    unread: false,
    read: false,
    starred: false,
    folder: null,
    label: null,
    before: null,
    after: null,
  };
  const tokens = q.match(/(\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+)/g) ?? [];
  for (const tok of tokens) {
    const m = tok.match(/^(\w+):(.*)$/);
    const key = m?.[1].toLowerCase();
    const val = (m?.[2] ?? tok).replace(/^"|"$/g, "").trim();
    if (!val) continue;
    switch (key) {
      case "from":
        out.from.push(val.toLowerCase());
        break;
      case "to":
      case "cc":
        out.to.push(val.toLowerCase());
        break;
      case "subject":
        out.subject.push(val);
        break;
      case "has":
        if (/^attach/.test(val)) out.hasAttachment = true;
        break;
      case "is":
        if (val === "unread") out.unread = true;
        if (val === "read") out.read = true;
        if (val === "starred") out.starred = true;
        break;
      case "in":
        if ((FOLDERS as readonly string[]).includes(val)) out.folder = val as Folder;
        break;
      case "label":
        out.label = val;
        break;
      case "before":
      case "after": {
        const d = Date.parse(val);
        if (!Number.isNaN(d)) out[key] = new Date(d).toISOString();
        break;
      }
      default:
        out.text.push(tok.replace(/^"|"$/g, ""));
    }
  }
  return out;
}

/** Build a safe FTS5 MATCH expression: every word is quoted and prefix-matched. */
export function ftsExpression(words: string[]): string | null {
  const parts = words
    .map((w) => w.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((w) => (w.includes(" ") ? `"${w}"` : `"${w}"*`));
  return parts.length ? parts.join(" AND ") : null;
}

/** Escape a LIKE pattern. Use with ESCAPE '\\'. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
