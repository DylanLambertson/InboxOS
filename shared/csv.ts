/**
 * CSV per RFC 4180, shared by the admin console (import wizard, templates) and the
 * worker (exports). Parsing is tolerant of what spreadsheets really produce: a UTF-8
 * BOM, LF or CRLF line endings, a trailing newline, blank lines and `;` or tab
 * separators. Writing always uses CRLF and quotes only when needed, and protects
 * against formula injection: a cell that starts with = + - @ (or a tab / CR) is
 * prefixed with `'` so spreadsheet apps show it as text instead of running it.
 */

export class CsvError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

export type Delimiter = "," | ";" | "\t";

/** Guess the separator from the first line: whichever of , ; or tab appears most outside quotes. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of stripBom(text)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch as Delimiter]++;
  }
  return counts[";"] > counts[","] && counts[";"] >= counts["\t"] ? ";" : counts["\t"] > counts[","] ? "\t" : ",";
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * Split CSV text into rows of fields. Blank lines are skipped. Throws CsvError
 * when a quoted field is never closed.
 */
export function parseCsv(input: string, delimiter: string = ","): string[][] {
  const text = stripBom(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  /** Nothing has been read for the current field yet (a quote here opens a quoted value). */
  let atFieldStart = true;
  /** The current line has something on it (so it isn't a blank line). */
  let rowHasContent = false;
  let line = 1;
  let quoteLine = 1;
  const endRow = () => {
    row.push(field);
    if (rowHasContent) rows.push(row);
    row = [];
    field = "";
    atFieldStart = true;
    rowHasContent = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      rowHasContent = true;
      quoteLine = line;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      atFieldStart = true;
      rowHasContent = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
    } else {
      // A stray quote inside an unquoted field is kept as-is, like spreadsheets do.
      field += ch;
      atFieldStart = false;
      rowHasContent = true;
    }
  }
  if (quoted) throw new CsvError(`Line ${quoteLine}: a quoted value is never closed.`, quoteLine);
  if (rowHasContent) endRow();
  return rows;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
  /** More data rows were present than `maxRows`; they were dropped. */
  truncated: boolean;
  delimiter: Delimiter;
}

/** Parse with a header row, auto-detecting the separator. Short rows are padded to the header width. */
export function parseCsvTable(text: string, opts: { maxRows?: number; delimiter?: Delimiter } = {}): CsvTable {
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const all = parseCsv(text, delimiter);
  const headers = (all[0] ?? []).map((h) => h.trim());
  const body = all.slice(1);
  const max = opts.maxRows ?? Infinity;
  const rows = body.slice(0, max).map((r) => (r.length < headers.length ? [...r, ...Array(headers.length - r.length).fill("")] : r));
  return { headers, rows, truncated: body.length > max, delimiter };
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, quoted when needed and protected against formula injection. */
export function csvCell(value: unknown, delimiter: string = ","): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  // Only text is guarded: a real number like -5 stays a number.
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return s.includes('"') || s.includes(delimiter) || /[\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Undo the export guard on import, so an exported file round-trips unchanged. */
export const unprotectCell = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

/** Rows to CSV text (CRLF line endings, trailing newline). */
export function toCsv(rows: unknown[][], delimiter: string = ","): string {
  return rows.map((r) => r.map((v) => csvCell(v, delimiter)).join(delimiter)).join("\r\n") + "\r\n";
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

/** Records to CSV with a header row. */
export function recordsToCsv<T>(columns: CsvColumn<T>[], records: T[]): string {
  return toCsv([columns.map((c) => c.header), ...records.map((r) => columns.map((c) => c.value(r)))]);
}

/** Normalise a header for matching: "E-mail Address" → "emailaddress". */
export const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Map each field to the column whose header matches one of its aliases (case,
 * spaces and punctuation ignored). Returns field → column index, or -1.
 */
export function autoMapColumns<F extends string>(headers: string[], aliases: Record<F, string[]>): Record<F, number> {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const out = {} as Record<F, number>;
  for (const field of Object.keys(aliases) as F[]) {
    const wanted = [field, ...aliases[field]].map(headerKey);
    const idx = keys.findIndex((k, i) => !used.has(i) && wanted.includes(k));
    out[field] = idx;
    if (idx >= 0) used.add(idx);
  }
  return out;
}
