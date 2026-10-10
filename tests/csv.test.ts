import { describe, expect, it } from "vitest";
import { autoMapColumns, csvCell, CsvError, detectDelimiter, parseCsv, parseCsvTable, recordsToCsv, toCsv, unprotectCell } from "@shared/csv";

describe("CSV parser", () => {
  it("splits simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("handles quotes, escaped quotes, delimiters and newlines inside quotes", () => {
    const text = 'name,note\r\n"Doe, Jane","She said ""hi""\r\nthen left"\r\n';
    expect(parseCsv(text)).toEqual([["name", "note"], ["Doe, Jane", 'She said "hi"\r\nthen left']]);
  });

  it("accepts LF, CRLF and lone CR line endings", () => {
    expect(parseCsv("a\nb\r\nc\rd")).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("strips a BOM and ignores the trailing newline and blank lines", () => {
    expect(parseCsv("﻿email\n\nx@y.co\n\n")).toEqual([["email"], ["x@y.co"]]);
  });

  it("keeps empty fields, including a trailing one", () => {
    expect(parseCsv("a,,c,\n")).toEqual([["a", "", "c", ""]]);
    expect(parseCsv('"",x')).toEqual([["", "x"]]);
  });

  it("quotes a later field, not only the first", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("keeps a stray quote in an unquoted field", () => {
    expect(parseCsv('5" screen,x')).toEqual([['5" screen', "x"]]);
  });

  it("reports an unterminated quote with its line", () => {
    try {
      parseCsv('a\n"b,c\nd');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CsvError);
      expect((e as CsvError).line).toBe(2);
    }
  });

  it("detects ; and tab separators", () => {
    expect(detectDelimiter("email;name\nx;y")).toBe(";");
    expect(detectDelimiter("email\tname")).toBe("\t");
    expect(detectDelimiter('"a;b",c')).toBe(",");
    expect(parseCsvTable("email;name\nx@y.co;Xi").rows).toEqual([["x@y.co", "Xi"]]);
  });

  it("pads short rows and caps the row count", () => {
    const t = parseCsvTable("a,b,c\n1\n2,2\n3,3,3", { maxRows: 2 });
    expect(t.headers).toEqual(["a", "b", "c"]);
    expect(t.rows).toEqual([["1", "", ""], ["2", "2", ""]]);
    expect(t.truncated).toBe(true);
  });
});

describe("CSV writer", () => {
  it("quotes only when needed", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(" padded ")).toBe('" padded "');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(3)).toBe("3");
  });

  it("guards against formula injection", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe("\"'\rx\"");
    // Real numbers stay numbers.
    expect(csvCell(-5)).toBe("-5");
  });

  it("writes CRLF rows that parse back to the same values", () => {
    const rows = [["email", "name"], ["a@b.co", 'Doe, "J"'], ["c@d.co", "=1+1"]];
    const text = toCsv(rows);
    expect(text.endsWith("\r\n")).toBe(true);
    const back = parseCsv(text).map((r) => r.map(unprotectCell));
    expect(back).toEqual(rows);
  });

  it("writes records with a header row", () => {
    const text = recordsToCsv([{ header: "Email", value: (r: { e: string }) => r.e }], [{ e: "x@y.co" }]);
    expect(text).toBe("Email\r\nx@y.co\r\n");
  });
});

describe("column auto-mapping", () => {
  it("matches headers ignoring case and punctuation, using each column once", () => {
    const map = autoMapColumns(["E-mail Address", "Full Name", "Role"], { email: ["emailaddress", "mail"], name: ["fullname"], role: [], phone: ["telephone"] });
    expect(map).toEqual({ email: 0, name: 1, role: 2, phone: -1 });
  });
});
