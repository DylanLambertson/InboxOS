import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronDown, Search, X } from "lucide-react";
import type { SortDir } from "@shared/admin";
import { cx, Input } from "@/components/ui/primitives";
import { Menu } from "@/components/ui/overlay";

/**
 * Table state kept in the URL (search, filters, sort, page), so a filtered view
 * survives a reload and can be shared as a link.
 */
export function useListState<F extends string>(filterKeys: readonly F[], defaults: { sort: string; dir: SortDir; limit?: number }) {
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(filterKeys.map((k) => [k, params.get(k) ?? ""])) as Record<F, string>;
  const state = {
    q: params.get("q") ?? "",
    filters,
    sort: params.get("sort") ?? defaults.sort,
    dir: (params.get("dir") === "desc" ? "desc" : params.get("dir") === "asc" ? "asc" : defaults.dir) as SortDir,
    page: Math.max(1, Number(params.get("page")) || 1),
    limit: [25, 50, 100, 200].includes(Number(params.get("limit"))) ? Number(params.get("limit")) : (defaults.limit ?? 50),
  };
  /** Change some values; anything but paging goes back to page 1. */
  const set = (patch: Partial<Record<F | "q" | "sort" | "dir" | "page" | "limit", string | number | null>>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) (v === null || v === "" || v === undefined ? next.delete(k) : next.set(k, String(v)));
        if (!("page" in patch)) next.delete("page");
        return next;
      },
      { replace: true },
    );
  const activeFilters = filterKeys.filter((k) => filters[k]).length;
  return { ...state, set, activeFilters, clearFilters: () => set(Object.fromEntries([...filterKeys, "q"].map((k) => [k, null])) as never) };
}

/** Search box that updates the list 300ms after typing stops. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onChange(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="relative min-w-56 flex-1 sm:max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="pl-8" type="search" aria-label={placeholder} />
    </div>
  );
}

/** A filter as a pill: "Role: Admin ▾", with × to clear. */
export function FilterChip({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value);
  return (
    <span className={cx("inline-flex h-8 items-center rounded-full border text-[13px]", current ? "border-accent-ink/40 bg-accent-soft text-accent-ink" : "border-line bg-surface text-fg-muted")}>
      <Menu
        width={220}
        items={options.map((o) => ({ label: o.label, checked: o.value === value, onSelect: () => onChange(o.value === value ? "" : o.value) }))}
        trigger={(p) => (
          <button type="button" {...p} className={cx("inline-flex h-full items-center gap-1 pl-3", current ? "pr-1" : "pr-2.5", "hover:text-fg")}>
            {label}
            {current && <span className="font-medium">: {current.label}</span>}
            {!current && <ChevronDown className="size-3.5" />}
          </button>
        )}
      />
      {current && (
        <button type="button" aria-label={`Clear ${label} filter`} onClick={() => onChange("")} className="mr-1 rounded-full p-1 hover:bg-accent/15">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
