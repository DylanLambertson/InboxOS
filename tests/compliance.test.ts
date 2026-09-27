import { describe, expect, it } from "vitest";
import { csvRow, discoveryWhere, emlFileName, zCriteria } from "../worker/lib/ediscovery";
import { base64Lines, Base64Stream, buildEml, encodeWord, formatAddress, rfc2822Date, type EmlMessage } from "../worker/lib/eml";
import { partitionHeld, resolveHeldMailboxes } from "../worker/lib/legal-hold";
import { purgeMessages } from "../worker/lib/messages";
import { effectiveRule, folderInScope, retentionCutoff } from "../worker/lib/retention";
import { crc32, dosDateTime, ZipWriter } from "../worker/lib/zip";

const dec = new TextDecoder();
const enc = new TextEncoder();
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe("legal hold", () => {
  const state = {
    holds: [
      { id: "h1", mailbox_id: "mbA", user_id: null },
      { id: "h2", mailbox_id: null, user_id: "u1" },
    ],
    members: [
      { user_id: "u1", mailbox_id: "mbB" },
      { user_id: "u2", mailbox_id: "mbC" },
    ],
    snapshots: [
      { hold_id: "h2", mailbox_id: "mbD" }, // u1 has since left mbD
      { hold_id: "gone", mailbox_id: "mbE" }, // released hold: not passed in as active
    ],
  };

  it("covers held mailboxes, held users' mailboxes and remembered memberships", () => {
    expect([...resolveHeldMailboxes(state)].sort()).toEqual(["mbA", "mbB", "mbD"]);
  });

  it("ignores memberships of people who aren't held", () => {
    expect(resolveHeldMailboxes(state).has("mbC")).toBe(false);
    expect(resolveHeldMailboxes(state).has("mbE")).toBe(false);
  });

  it("holds nothing when there are no active holds", () => {
    expect(resolveHeldMailboxes({ holds: [], members: state.members, snapshots: state.snapshots }).size).toBe(0);
  });

  it("partitions rows into deletable and kept", () => {
    const rows = [
      { id: "1", mailbox_id: "mbA" },
      { id: "2", mailbox_id: "mbX" },
      { id: "3", mailbox_id: "mbB" },
    ];
    const { deletable, kept } = partitionHeld(rows, new Set(["mbA", "mbB"]));
    expect(deletable.map((r) => r.id)).toEqual(["2"]);
    expect(kept.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("purgeMessages never deletes held mail and moves held drafts to Trash", async () => {
    const messages = new Map([
      ["m1", { id: "m1", mailbox_id: "held", folder: "trash" }],
      ["m2", { id: "m2", mailbox_id: "held", folder: "drafts" }],
      ["m3", { id: "m3", mailbox_id: "free", folder: "trash" }],
    ]);
    const deletedR2: string[] = [];
    const db = fakeDb(messages);
    const files = { delete: async (k: string[]) => void deletedR2.push(...k) } as unknown as R2Bucket;
    const r = await purgeMessages(db, files, ["m1", "m2", "m3"], new Set(["held"]));
    expect(r).toEqual({ purged: 1, kept: 2 });
    expect([...messages.keys()].sort()).toEqual(["m1", "m2"]);
    expect(messages.get("m2")!.folder).toBe("trash");
  });
});

/** Just enough of D1 for purgeMessages: SELECT/UPDATE/DELETE by `id IN (...)`. */
function fakeDb(messages: Map<string, { id: string; mailbox_id: string; folder: string }>): D1Database {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => {
      if (/SELECT id, mailbox_id, folder FROM messages/.test(sql)) return { results: args.map((id) => messages.get(id as string)).filter(Boolean) };
      return { results: [] };
    },
    run: async () => {
      if (/^\s*UPDATE messages SET folder_before_trash/.test(sql)) for (const id of args.slice(2)) messages.get(id as string)!.folder = "trash";
      if (/^DELETE FROM messages WHERE/.test(sql)) for (const id of args) messages.delete(id as string);
      return { meta: { changes: 0 } };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
}

describe("retention", () => {
  const org = { retentionDays: 365, retentionScope: "all" as const };
  it("follows the org unless the mailbox overrides it", () => {
    expect(effectiveRule(org, { retention_days: null, retention_scope: null })).toEqual({ days: 365, scope: "all" });
    expect(effectiveRule(org, { retention_days: 30, retention_scope: "archive" })).toEqual({ days: 30, scope: "archive" });
    expect(effectiveRule(org, { retention_days: 30, retention_scope: null })).toEqual({ days: 30, scope: "all" });
  });
  it("is off by default and 0 means keep forever", () => {
    expect(effectiveRule({ retentionDays: 0, retentionScope: "all" }, { retention_days: null, retention_scope: null })).toBeNull();
    expect(effectiveRule(org, { retention_days: 0, retention_scope: "all" })).toBeNull();
    expect(effectiveRule({ retentionDays: 0, retentionScope: "all" }, { retention_days: 10, retention_scope: "all" })).toEqual({ days: 10, scope: "all" });
  });
  it("never targets drafts or scheduled mail", () => {
    expect(folderInScope("drafts", "all")).toBe(false);
    expect(folderInScope("scheduled", "all")).toBe(false);
    expect(folderInScope("inbox", "all")).toBe(true);
    expect(folderInScope("inbox", "archive")).toBe(false);
    expect(folderInScope("archive", "archive")).toBe(true);
  });
  it("computes the cutoff", () => {
    expect(retentionCutoff(1, Date.parse("2026-10-02T00:00:00.000Z"))).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("zip", () => {
  it("computes CRC-32, incrementally too", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(enc.encode("6789"), crc32(enc.encode("12345")))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("encodes DOS dates", () => {
    const { date, time } = dosDateTime(new Date("2026-10-01T13:45:30Z"));
    expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 1);
    expect(time).toBe((13 << 11) | (45 << 5) | 15);
  });

  it("writes an archive whose central directory points at its entries", () => {
    const zip = new ZipWriter();
    const parts = [...zip.file("a.txt", [enc.encode("hello "), enc.encode("world")]), ...zip.file("dir/ü.eml", [enc.encode("x")])];
    parts.push(zip.finish());
    const buf = concat(parts);
    expect(zip.size).toBe(buf.length);
    const v = new DataView(buf.buffer);
    const eocd = buf.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(2);
    let p = v.getUint32(eocd + 16, true);
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const size = v.getUint32(p + 24, true);
      const crc = v.getUint32(p + 16, true);
      const nameLen = v.getUint16(p + 28, true);
      const off = v.getUint32(p + 42, true);
      names.push(dec.decode(buf.subarray(p + 46, p + 46 + nameLen)));
      expect(v.getUint32(off, true)).toBe(0x04034b50);
      const dataStart = off + 30 + v.getUint16(off + 26, true);
      expect(crc32(buf.subarray(dataStart, dataStart + size))).toBe(crc);
      p += 46 + nameLen;
    }
    expect(names).toEqual(["a.txt", "dir/ü.eml"]);
  });
});

describe("eml", () => {
  const msg: EmlMessage = {
    id: "m1",
    mailbox: "hello@example.com",
    folder: "inbox",
    from: { email: "alice@example.com", name: "Alice \"A\" Smith" },
    to: [{ email: "bob@example.com", name: "Bøb" }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Quarterly report – Q3\r\nBcc: evil@x.com",
    date: "2026-10-01T12:00:00.000Z",
    messageId: "<abc@example.com>",
    inReplyTo: null,
    references: null,
    text: "Hello",
    html: '<p>Hello <img src="cid:logo"></p>',
  };

  it("encodes headers safely", () => {
    expect(formatAddress(msg.from)).toBe('"Alice \\"A\\" Smith" <alice@example.com>');
    expect(formatAddress(msg.to[0])).toMatch(/^=\?UTF-8\?B\?.+\?= <bob@example.com>$/);
    expect(encodeWord("plain")).toBe("plain");
    expect(encodeWord("a\r\nb")).toBe("a b");
    expect(rfc2822Date("2026-10-01T12:00:00.000Z")).toBe("Thu, 01 Oct 2026 12:00:00 +0000");
    const long = encodeWord("é".repeat(100));
    expect(long.split("\r\n ").every((w) => w.length <= 75)).toBe(true);
  });

  it("wraps base64 at 76 chars, streaming or not", () => {
    const data = crypto.getRandomValues(new Uint8Array(1000));
    const whole = base64Lines(data);
    expect(whole.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    const s = new Base64Stream();
    const streamed = s.push(data.subarray(0, 100)) + s.push(data.subarray(100, 777)) + s.push(data.subarray(777)) + s.end();
    expect(streamed).toBe(whole);
  });

  it("builds a multipart message with inline and regular attachments", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const pdf = enc.encode("%PDF-1.4 test");
    const chunks = await buildEml(
      msg,
      [
        { filename: "logo.png", contentType: "image/png", contentId: "logo", inline: true },
        { filename: "rapport été.pdf", contentType: "application/pdf", contentId: null, inline: false },
      ],
      async (_a, i) => (i === 0 ? png : pdf),
    );
    const eml = dec.decode(concat(chunks));
    const [head] = eml.split("\r\n\r\n");
    // The CRLF in the subject must not become a header.
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(head).toMatch(/^Content-Type: multipart\/mixed;/m);
    expect(eml).toContain("multipart/related");
    expect(eml).toContain("multipart/alternative");
    expect(eml).toContain("Content-ID: <logo>");
    expect(eml).toContain("filename*=UTF-8''rapport%20%C3%A9t%C3%A9.pdf");
    expect(eml).toContain(btoa("%PDF-1.4 test"));
    // Every boundary that opens also closes.
    const opened = [...eml.matchAll(/boundary="([^"]+)"/g)].map((m) => m[1]);
    expect(opened).toHaveLength(3);
    for (const b of opened) expect(eml).toContain(`--${b}--`);
  });

  it("is a single text part when there's nothing else", async () => {
    const eml = dec.decode(concat(await buildEml({ ...msg, html: null, subject: "Hi" }, [], async () => null)));
    expect(eml).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(eml).not.toContain("multipart");
  });
});

describe("ediscovery search", () => {
  it("combines form fields with search syntax", () => {
    const c = zCriteria.parse({ q: "from:carol invoice", to: "dave", after: "2026-01-01", before: "2026-01-31", hasAttachment: true, mailboxIds: ["mb1"] });
    const { where, args } = discoveryWhere(c);
    expect(where.some((w) => w.includes("m.from_addr LIKE"))).toBe(true);
    expect(where.some((w) => w.includes("m.bcc_json LIKE"))).toBe(true);
    expect(where.some((w) => w.includes("messages_fts MATCH"))).toBe(true);
    expect(where).toContain("m.has_attachments = 1");
    expect(args).toContain("%carol%");
    expect(args).toContain('"invoice"*');
    expect(args).toContain("2026-01-01T00:00:00.000Z");
    // "To date" includes that whole day.
    expect(args).toContain("2026-02-01T00:00:00.000Z");
    expect(args).toContain(JSON.stringify(["mb1"]));
  });

  it("escapes LIKE wildcards and matches everything when empty", () => {
    expect(discoveryWhere({ subject: "100%_off" }).args).toEqual(["%100\\%\\_off%"]);
    expect(discoveryWhere({}).where).toEqual([]);
  });

  it("rejects malformed dates", () => {
    expect(zCriteria.safeParse({ after: "yesterday" }).success).toBe(false);
  });

  it("writes manifest rows a spreadsheet won't execute", () => {
    expect(csvRow(["=HYPERLINK(1)", 'say "hi"', "a,b", 3])).toBe(`'=HYPERLINK(1),"say ""hi""","a,b",3`);
  });

  it("names files safely", () => {
    expect(emlFileName(0, "2026-10-01T12:00:00Z", "Re: ../../etc/passwd?")).toBe("messages/0001_2026-10-01_Re-etcpasswd.eml");
    expect(emlFileName(41, "2026-10-01T12:00:00Z", "")).toBe("messages/0042_2026-10-01_no-subject.eml");
  });
});
