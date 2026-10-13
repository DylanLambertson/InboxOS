import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import type { SortDir } from "@shared/admin";
import { Button, cx, LoadError, Select, Spinner } from "@/components/ui/primitives";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Server sort key; the header becomes a sort button. */
  sort?: string;
  /** Sort this way first when the column is picked (e.g. newest first for dates). */
  firstDir?: SortDir;
  className?: string;
  render: (row: T) => ReactNode;
}

/** Either specific rows, or everything matching the current filters (possibly more than one page). */
export type Selection = { all: false; ids: Set<string> } | { all: true };
export const emptySelection = (): Selection => ({ all: false, ids: new Set() });
export const selectionCount = (s: Selection, total: number) => (s.all ? total : s.ids.size);

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  rowLabel: (r: T) => string;
  sort: string;
  dir: SortDir;
  onSort: (sort: string, dir: SortDir) => void;
  total: number;
  /** "people", "mailboxes": used in the selection banner. */
  noun: string;
  selection?: Selection;
  onSelection?: (s: Selection) => void;
  loading?: boolean;
  fetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  onOpen?: (row: T) => void;
  minWidth?: number;
  rowClassName?: (row: T) => string | false | undefined;
}

const INTERACTIVE = "button,a,input,select,textarea,label,[role=menu],[role=switch]";

/**
 * The admin console's table: sticky header, server-side sort, row selection with
 * shift-click ranges and "select all matching", and keyboard navigation
 * (↑/↓ to move, Space or X to select, Enter to open).
 */
export function DataTable<T>(p: Props<T>) {
  const { rows, rowKey, selection, onSelection } = p;
  const selectable = !!selection && !!onSelection;
  const last = useRef<number | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const isSelected = (id: string) => !!selection && (selection.all || selection.ids.has(id));
  const pageIds = rows.map(rowKey);
  const allOnPage = pageIds.length > 0 && pageIds.every(isSelected);
  const someOnPage = pageIds.some(isSelected);

  const toggle = (index: number, on: boolean, range: boolean) => {
    if (!selection || !onSelection) return;
    // Leaving "all matching" keeps this page's rows, then applies the change.
    const ids = new Set(selection.all ? pageIds : selection.ids);
    const [from, to] = range && last.current !== null ? [Math.min(last.current, index), Math.max(last.current, index)] : [index, index];
    for (let i = from; i <= to; i++) (on ? ids.add(pageIds[i]) : ids.delete(pageIds[i]));
    last.current = index;
    onSelection({ all: false, ids });
  };
  const togglePage = (on: boolean) => {
    if (!selection || !onSelection) return;
    const ids = new Set(selection.all ? [] : selection.ids);
    for (const id of pageIds) (on ? ids.add(id) : ids.delete(id));
    onSelection({ all: false, ids });
  };

  const focusRow = (i: number) => body.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]")[i]?.focus();
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number, row: T) => {
    if ((e.target as HTMLElement) !== e.currentTarget) return;
    if (e.key === "ArrowDown" || e.key === "j") (e.preventDefault(), focusRow(i + 1));
    else if (e.key === "ArrowUp" || e.key === "k") (e.preventDefault(), focusRow(i - 1));
    else if ((e.key === " " || e.key === "x") && selectable) (e.preventDefault(), toggle(i, !isSelected(pageIds[i]), e.shiftKey));
    else if (e.key === "Enter" && p.onOpen) (e.preventDefault(), p.onOpen(row));
  };
  const onRowClick = (e: MouseEvent, row: T) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    p.onOpen?.(row);
  };

  const sortButton = (c: Column<T>) => {
    if (!c.sort) return c.header;
    const active = p.sort === c.sort;
    const Icon = !active ? ChevronsUpDown : p.dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        onClick={() => p.onSort(c.sort!, active ? (p.dir === "asc" ? "desc" : "asc") : (c.firstDir ?? "asc"))}
        className={cx("-mx-1 inline-flex items-center gap-1 rounded-ui-sm px-1 py-0.5 hover:bg-muted hover:text-fg", active && "text-fg")}
      >
        {c.header}
        <Icon className={cx("size-3.5", !active && "opacity-40")} />
      </button>
    );
  };

  const banner =
    selectable && p.total > rows.length && (selection!.all || allOnPage) ? (
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-line bg-accent-softer px-4 py-2 text-[13px]">
        {selection!.all ? (
          <>
            All {p.total.toLocaleString()} {p.noun} matching your filters are selected.
            <button className="font-medium text-accent-ink hover:underline" onClick={() => onSelection!(emptySelection())}>Clear selection</button>
          </>
        ) : (
          <>
            All {rows.length} {p.noun} on this page are selected.
            <button className="font-medium text-accent-ink hover:underline" onClick={() => onSelection!({ all: true })}>
              Select all {p.total.toLocaleString()} matching
            </button>
          </>
        )}
      </div>
    ) : null;

  if (p.error) return <LoadError error={p.error} onRetry={p.onRetry} />;
  return (
    <div>
      {banner}
      <div className="max-h-[calc(100dvh-300px)] min-h-48 overflow-auto">
        <table className="w-full text-[13px]" style={{ minWidth: p.minWidth ?? 720 }}>
          <thead className="text-left text-xs text-fg-muted">
            <tr>
              {selectable && (
                <th className="sticky top-0 z-[1] w-10 border-b border-line bg-surface py-2.5 pl-5">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allOnPage}
                    ref={(el) => {
                      if (el) el.indeterminate = !allOnPage && someOnPage;
                    }}
                    onChange={(e) => togglePage(e.target.checked)}
                    className="size-4 cursor-pointer rounded border-line-strong accent-[var(--accent)]"
                  />
                </th>
              )}
              {p.columns.map((c, i) => (
                <th
                  key={c.key}
                  aria-sort={p.sort === c.sort ? (p.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cx("sticky top-0 z-[1] border-b border-line bg-surface px-3 py-2.5 font-medium whitespace-nowrap", i === 0 && !selectable && "pl-5")}
                >
                  {sortButton(c)}
                  {i === p.columns.length - 1 && p.fetching && !p.loading && <Spinner className="ml-2 inline size-3" />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={body} className={cx("divide-y divide-line transition-opacity", p.fetching && !p.loading && "opacity-70")}>
            {p.loading
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    {selectable && <td className="py-3.5 pl-5"><div className="size-4 rounded bg-muted" /></td>}
                    {p.columns.map((c) => (
                      <td key={c.key} className="px-3 py-3.5">
                        <div className="h-3.5 animate-pulse rounded bg-muted" style={{ width: `${40 + ((i * 7 + c.key.length * 13) % 50)}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row, i) => {
                  const id = rowKey(row);
                  const on = isSelected(id);
                  return (
                    <tr
                      key={id}
                      data-row
                      tabIndex={0}
                      aria-selected={selectable ? on : undefined}
                      onKeyDown={(e) => onRowKey(e, i, row)}
                      onClick={(e) => onRowClick(e, row)}
                      className={cx(
                        "outline-none focus-visible:bg-subtle focus-visible:shadow-[inset_2px_0_0_var(--accent-ink)]",
                        p.onOpen && "cursor-pointer",
                        on ? "bg-accent-softer" : "hover:bg-subtle",
                        p.rowClassName?.(row),
                      )}
                    >
                      {selectable && (
                        <td className="py-3 pl-5">
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.rowLabel(row)}`}
                            checked={on}
                            onChange={() => {}}
                            onClick={(e) => toggle(i, !on, e.shiftKey)}
                            className="size-4 cursor-pointer rounded border-line-strong accent-[var(--accent)]"
                          />
                        </td>
                      )}
                      {p.columns.map((c, ci) => (
                        <td key={c.key} className={cx("px-3 py-3", ci === 0 && !selectable && "pl-5", c.className)}>
                          {c.render(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!p.loading && rows.length === 0 && p.empty}
      </div>
    </div>
  );
}

/** "1–50 of 1,234" with previous/next and a page-size picker. */
export function Pagination({ page, limit, total, onPage, onLimit }: { page: number; limit: number; total: number; onPage: (p: number) => void; onLimit: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total ? (page - 1) * limit + 1 : 0;
  const to = Math.min(total, page * limit);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-2.5 text-xs text-fg-muted">
      <span className="tabular-nums">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          Rows
          <Select value={limit} onChange={(e) => onLimit(Number(e.target.value))} className="h-7 w-20 text-xs" aria-label="Rows per page">
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </Select>
        </label>
        <Button size="xs" icon={<ChevronLeft className="size-3.5" />} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" />
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button size="xs" icon={<ChevronRight className="size-3.5" />} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page" />
      </div>
    </div>
  );
}

/** Selection that resets whenever the list it refers to changes (filters, sort). */
export function useSelection(resetKey: string) {
  const [state, setState] = useState<{ key: string; sel: Selection }>({ key: resetKey, sel: emptySelection() });
  const selection = state.key === resetKey ? state.sel : emptySelection();
  return [selection, (sel: Selection) => setState({ key: resetKey, sel })] as const;
}
