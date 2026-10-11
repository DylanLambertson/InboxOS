import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileUp, MinusCircle, XCircle } from "lucide-react";
import { autoMapColumns, CsvError, parseCsvTable, unprotectCell, type CsvTable } from "@shared/csv";
import {
  CHECK_ROW,
  countImport,
  IMPORT_CHUNK,
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  IMPORT_TEMPLATES,
  ROW_KEY,
  type ImportKind,
  type ImportResponse,
  type ImportRowResult,
  type ImportRowStatus,
} from "@shared/admin-import";
import { api, errorMessage } from "@/lib/api";
import { Button, cx, Field, Select, Spinner, Textarea } from "@/components/ui/primitives";
import { Modal, Tabs } from "@/components/ui/overlay";
import { downloadCsv } from "../table/download";

const NOUN: Record<ImportKind, string> = { users: "people", mailboxes: "mailboxes", aliases: "aliases" };
const TITLE: Record<ImportKind, string> = { users: "Import people", mailboxes: "Import mailboxes", aliases: "Import aliases" };
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Step = "source" | "map" | "preview" | "running" | "done";

const STATUS_UI: Record<ImportRowStatus, { label: string; icon: React.ReactNode; tone: string }> = {
  create: { label: "Will be added", icon: <CheckCircle2 className="size-4" />, tone: "text-success" },
  skip: { label: "Skipped", icon: <MinusCircle className="size-4" />, tone: "text-fg-muted" },
  error: { label: "Problems", icon: <XCircle className="size-4" />, tone: "text-danger" },
};

/** Browser-side checks first, for instant feedback; the server's dry run is the real answer. */
function localCheck(kind: ImportKind, rows: Record<string, string>[]): ImportRowResult[] {
  const seen = new Map<string, number>();
  return rows.map((raw, i) => {
    const r = CHECK_ROW[kind](raw);
    const key = ROW_KEY[kind](raw);
    const errors = [...r.errors];
    if (key && seen.has(key)) errors.push(`Listed twice in this file (first on row ${seen.get(key)}).`);
    else if (key) seen.set(key, i + 1);
    return { row: i + 1, key, status: errors.length ? "error" : "create", errors, warnings: r.warnings };
  });
}

/**
 * CSV import in five steps: upload or paste, match columns (guessed from the
 * headers), preview every row with the server's dry run, import in chunks with a
 * progress bar, and a report at the end. Re-running the same file is safe:
 * anything that already exists is skipped.
 */
export function ImportWizard({ kind, onClose, onDone }: { kind: ImportKind; onClose: () => void; onDone: () => void }) {
  const fields = IMPORT_FIELDS[kind];
  const [step, setStep] = useState<Step>("source");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [table, setTable] = useState<CsvTable | null>(null);
  const [problem, setProblem] = useState("");
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [results, setResults] = useState<ImportRowResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [tab, setTab] = useState<ImportRowStatus | "all">("all");

  const read = (raw: string, name = "") => {
    setProblem("");
    try {
      const t = parseCsvTable(raw, { maxRows: IMPORT_MAX_ROWS });
      if (!t.headers.length || !t.rows.length) return setProblem("We couldn't find a header row and at least one row of data.");
      setTable(t);
      setFileName(name);
      setMapping(autoMapColumns(t.headers, Object.fromEntries(fields.map((f) => [f.key, f.aliases]))));
      setStep("map");
    } catch (e) {
      setProblem(e instanceof CsvError ? e.message : "That doesn't look like a CSV file.");
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return setProblem("That file is over 2 MB. Split it into smaller files.");
    read(await f.text(), f.name);
  };

  const rows = useMemo(
    () => (table ? table.rows.map((r) => Object.fromEntries(fields.map((f) => [f.key, mapping[f.key] >= 0 ? unprotectCell((r[mapping[f.key]] ?? "").trim()) : ""]))) : []),
    [table, mapping, fields],
  );
  const missing = fields.filter((f) => f.required && !(mapping[f.key] >= 0));

  const preview = async () => {
    setStep("preview");
    setResults(localCheck(kind, rows));
    setChecking(true);
    try {
      const r = await api.post<ImportResponse>(`admin/import/${kind}`, { rows, dryRun: true });
      setResults(r.results);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const run = async () => {
    setStep("running");
    setProgress({ done: 0, total: rows.length });
    const out: ImportRowResult[] = [];
    for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
      const chunk = rows.slice(i, i + IMPORT_CHUNK);
      try {
        const r = await api.post<ImportResponse>(`admin/import/${kind}`, { rows: chunk, dryRun: false, startRow: i + 1 });
        out.push(...r.results);
      } catch (e) {
        chunk.forEach((raw, j) => out.push({ row: i + j + 1, key: ROW_KEY[kind](raw), status: "error", errors: [errorMessage(e)], warnings: [] }));
      }
      setProgress({ done: Math.min(rows.length, i + chunk.length), total: rows.length });
    }
    setResults(out);
    setTab("all");
    setStep("done");
    onDone();
  };

  const counts = countImport(results ?? []);
  const added = (results ?? []).filter((r) => r.done).length;
  const shown = (results ?? []).filter((r) => tab === "all" || r.status === tab);
  const report = () =>
    downloadCsv(`import-${kind}-report`, [
      ["row", "item", "result", "problems", "notes"],
      ...(results ?? []).map((r) => [r.row, r.key, r.done ? "added" : r.status === "create" ? "ready" : r.status, r.errors.join(" "), r.warnings.join(" ")]),
    ]);

  const footer =
    step === "source" ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!text.trim()} onClick={() => read(text)}>Continue</Button>
      </>
    ) : step === "map" ? (
      <>
        <Button onClick={() => setStep("source")}>Back</Button>
        <Button variant="primary" disabled={missing.length > 0} onClick={preview}>Check rows</Button>
      </>
    ) : step === "preview" ? (
      <>
        <Button onClick={() => setStep("map")}>Back</Button>
        <Button variant="primary" disabled={checking || !counts.create || !!problem} onClick={run}>
          {checking ? "Checking…" : counts.create ? `Import ${counts.create.toLocaleString()} ${NOUN[kind]}` : "Nothing to import"}
        </Button>
      </>
    ) : step === "done" ? (
      <>
        <Button icon={<Download className="size-4" />} onClick={report}>Download report</Button>
        <Button variant="primary" onClick={onClose}>Done</Button>
      </>
    ) : undefined;

  return (
    <Modal open onClose={step === "running" ? () => {} : onClose} title={step === "done" ? "Import finished" : TITLE[kind]} width={760} footer={footer}>
      <ol className="mb-4 flex gap-1 text-[11px] font-medium text-fg-muted" aria-label="Steps">
        {(["source", "map", "preview", "done"] as const).map((s, i) => {
          const order = ["source", "map", "preview", "running", "done"];
          const active = order.indexOf(step) >= order.indexOf(s);
          return (
            <li key={s} className={cx("flex-1 border-t-2 pt-1.5", active ? "border-accent text-fg" : "border-line")}>
              {i + 1}. {["Upload", "Match columns", "Review", "Import"][i]}
            </li>
          );
        })}
      </ol>
      {problem && (
        <p className="mb-3 flex items-start gap-2 rounded-ui bg-danger-soft p-3 text-[13px] text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {problem}
        </p>
      )}

      {step === "source" && (
        <div className="space-y-4">
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-ui border-2 border-dashed border-line px-6 py-8 text-center hover:border-accent hover:bg-subtle"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => (e.preventDefault(), onFile(e.dataTransfer.files[0]))}
          >
            <FileUp className="size-6 text-fg-muted" />
            <span className="text-[13px] font-medium">Drop a CSV file here, or click to choose one</span>
            <span className="text-xs text-fg-muted">Up to {IMPORT_MAX_ROWS.toLocaleString()} rows. Comma, semicolon and tab separated files all work.</span>
            <input type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <Field label="Or paste rows" hint="Include the header row.">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} className="font-mono text-xs" placeholder={IMPORT_TEMPLATES[kind].slice(0, 2).map((r) => r.join(",")).join("\n")} />
          </Field>
          <div className="rounded-ui bg-subtle p-3 text-xs text-fg-muted">
            <p className="mb-1.5 font-medium text-fg">Columns</p>
            <ul className="space-y-0.5">
              {fields.map((f) => (
                <li key={f.key}><span className="font-medium text-fg">{f.label}</span>{f.required && " (required)"}: {f.hint}</li>
              ))}
            </ul>
            <button className="mt-2 inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => downloadCsv(`${kind}-template`, IMPORT_TEMPLATES[kind])}>
              <Download className="size-3.5" /> Download a template
            </button>
          </div>
        </div>
      )}

      {step === "map" && table && (
        <div className="space-y-3">
          <p className="text-[13px] text-fg-muted">
            {fileName ? <span className="font-medium text-fg">{fileName}</span> : "Your rows"}: {table.rows.length.toLocaleString()} row{table.rows.length === 1 ? "" : "s"}.
            {table.truncated && ` Only the first ${IMPORT_MAX_ROWS.toLocaleString()} are imported; split the file to import the rest.`} We matched the columns we recognised.
          </p>
          <div className="divide-y divide-line rounded-ui border border-line">
            {fields.map((f) => (
              <div key={f.key} className="grid grid-cols-[1fr_1fr] items-center gap-3 px-3 py-2 sm:grid-cols-[160px_220px_1fr]">
                <span className="text-[13px] font-medium">
                  {f.label}
                  {f.required && <span className="text-danger"> *</span>}
                </span>
                <Select value={mapping[f.key] ?? -1} onChange={(e) => setMapping({ ...mapping, [f.key]: Number(e.target.value) })} className="h-8 text-[13px]" aria-label={`Column for ${f.label}`}>
                  <option value={-1}>Don't import</option>
                  {table.headers.map((h, i) => (
                    <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                  ))}
                </Select>
                <span className="col-span-2 truncate text-xs text-fg-muted sm:col-span-1">
                  {mapping[f.key] >= 0 ? `e.g. ${table.rows[0]?.[mapping[f.key]] || "(empty)"}` : f.hint}
                </span>
              </div>
            ))}
          </div>
          {missing.length > 0 && <p className="text-xs text-danger">Choose a column for {missing.map((f) => f.label).join(", ")}.</p>}
        </div>
      )}

      {step === "running" && (
        <div className="space-y-3 py-4">
          <p className="text-[13px] text-fg-muted">Importing… {progress.done.toLocaleString()} of {progress.total.toLocaleString()} rows. Keep this window open.</p>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <div className="h-full bg-accent transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      {(step === "preview" || step === "done") && results && (
        <div className="space-y-3">
          {step === "done" && (
            <p className="text-[13px]">
              Added <b>{added.toLocaleString()}</b> {NOUN[kind]}. {counts.skip ? `${counts.skip.toLocaleString()} already existed and were left as they were. ` : ""}
              {counts.error ? `${counts.error.toLocaleString()} had problems; fix them and import the file again.` : ""}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "all", label: `All ${results.length.toLocaleString()}` },
                ...(["create", "skip", "error"] as const).filter((s) => counts[s]).map((s) => ({ value: s, label: `${step === "done" && s === "create" ? "Added" : STATUS_UI[s].label} ${counts[s].toLocaleString()}` })),
              ]}
            />
            {checking && <span className="flex items-center gap-1.5 text-xs text-fg-muted"><Spinner className="size-3" /> Checking against existing data…</span>}
          </div>
          <div className="max-h-96 overflow-auto rounded-ui border border-line">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface text-left text-xs text-fg-muted">
                <tr>
                  <th className="border-b border-line px-3 py-2 font-medium">Row</th>
                  <th className="border-b border-line px-3 py-2 font-medium">{fields[0].label}</th>
                  <th className="border-b border-line px-3 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.slice(0, IMPORT_MAX_ROWS).map((r) => (
                  <tr key={r.row} className="align-top">
                    <td className="px-3 py-2 text-fg-muted tabular-nums">{r.row}</td>
                    <td className="max-w-56 truncate px-3 py-2">{r.key || <span className="text-fg-faint">(empty)</span>}</td>
                    <td className="px-3 py-2">
                      <span className={cx("flex items-center gap-1.5 font-medium", STATUS_UI[r.status].tone)}>
                        {STATUS_UI[r.status].icon} {r.done ? "Added" : STATUS_UI[r.status].label}
                      </span>
                      {[...r.errors, ...r.warnings].map((m, i) => (
                        <span key={i} className={cx("block text-xs", i < r.errors.length ? "text-danger" : "text-fg-muted")}>{m}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
