import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AtSign, Globe, History, Inbox, Search, User, X } from "lucide-react";
import type { AdminSearchResults } from "@shared/admin";
import { api } from "@/lib/api";
import { highlightRanges, jumpGroup, moveIndex, parseRecent, pushRecent, rankEntries, type RankedGroup } from "@/lib/palette-match";
import { useMailboxes, useMe } from "@/lib/queries";
import { cx, Kbd, Spinner } from "../ui/primitives";
import { GROUPS, searchMailCommand, usePaletteCommands, warmCommand, type Command } from "./commands";

const RECENT_KEY = "io:palette-recent";
interface RecentItem {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  to?: string;
}

function readRecent(): RecentItem[] {
  try {
    return parseRecent<RecentItem>(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}
function saveRecent(list: RecentItem[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode or storage full: recents are a nicety */
  }
}

/** Debounced copy of a value. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Live people / mailbox / alias / domain results for the console roles. */
function useEntityCommands(query: string, enabled: boolean, navigate: (to: string) => void): { commands: Command[]; loading: boolean } {
  const q = useDebounced(query.trim(), 150);
  const { data, isFetching } = useQuery({
    queryKey: ["admin-search", q],
    queryFn: () => api.get<AdminSearchResults>(`admin/search?q=${encodeURIComponent(q)}`),
    enabled: enabled && q.length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const commands = useMemo<Command[]>(() => {
    if (!data || !enabled || q.length < 2) return [];
    const nav = (to: string) => ({ to, run: () => navigate(to) });
    return [
      ...data.users.map((u) => ({
        id: `entity:user:${u.id}`,
        title: u.name || u.email,
        subtitle: [u.name ? u.email : null, u.role, u.status !== "active" ? u.status : null].filter(Boolean).join(" · "),
        group: "People",
        icon: User,
        ...nav(`/admin/users?q=${encodeURIComponent(u.email)}`),
      })),
      ...data.mailboxes.map((m) => ({
        id: `entity:mailbox:${m.id}`,
        title: m.address,
        subtitle: [m.name, m.type === "shared" ? "Shared" : "Personal"].filter(Boolean).join(" · "),
        group: "Manage mailboxes",
        icon: Inbox,
        ...nav(`/admin/mailboxes?open=${encodeURIComponent(m.id)}`),
      })),
      ...data.aliases.map((a) => ({
        id: `entity:alias:${a.address}`,
        title: a.address,
        subtitle: `Alias of ${a.mailbox}`,
        group: "Aliases",
        icon: AtSign,
        ...nav(`/admin/mailboxes?open=${encodeURIComponent(a.mailboxId)}`),
      })),
      ...data.domains.map((d) => ({
        id: `entity:domain:${d.name}`,
        title: d.name,
        subtitle: d.primary ? "Primary domain" : "Mail domain",
        group: "Domains",
        icon: Globe,
        ...nav("/admin/domains"),
      })),
    ];
  }, [data, enabled, q, navigate]);
  return { commands, loading: enabled && q.length >= 2 && isFetching };
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) parts.push(text.slice(at, s));
    parts.push(
      <mark key={i} className="bg-transparent font-semibold text-accent">
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: me } = useMe();
  const { data: boxes = [] } = useMailboxes();
  const commands = usePaletteCommands();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<RecentItem[]>(readRecent);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const consoleRole = me?.role === "owner" || me?.role === "admin" || me?.role === "manager";
  const entities = useEntityCommands(query, consoleRole, navigate);

  const groups: RankedGroup<Command>[] = useMemo(() => {
    const q = query.trim();
    if (!q) {
      const byId = new Map(commands.map((c) => [c.id, c]));
      const recents = recent
        .map((r) => byId.get(r.id) ?? (r.id.startsWith("entity:") && r.to ? ({ ...r, icon: History, run: () => navigate(r.to!) } as Command) : null))
        .filter((c): c is Command => !!c)
        .slice(0, 5);
      const seen = new Set(recents.map((c) => c.id));
      const suggestions = commands.filter((c) => c.group === GROUPS.actions && !seen.has(c.id)).slice(0, 6);
      const views = commands.filter((c) => c.group === GROUPS.mail && !seen.has(c.id)).slice(0, 4);
      return [
        { group: "Recent", items: recents },
        { group: GROUPS.actions, items: suggestions },
        { group: GROUPS.mail, items: views },
      ].filter((g) => g.items.length);
    }
    const scope = pathname.match(/^\/mail\/([^/]+)/)?.[1] ?? (boxes.length > 1 ? "all" : boxes[0]?.id);
    const search = searchMailCommand(q, scope, navigate);
    const ranked = rankEntries(commands, q, { recent: recent.map((r) => r.id), limitPerGroup: 6 });
    const entityGroups = rankEntries(entities.commands, "", { limitPerGroup: 6 });
    const out = [...ranked, ...entityGroups];
    if (search) {
      // The search suggestion goes after the top result, or first when nothing else matched.
      const first = out[0];
      if (first?.group === GROUPS.actions) first.items = [first.items[0], search, ...first.items.slice(1)];
      else out.splice(first ? 1 : 0, 0, { group: GROUPS.actions, items: [search] });
    }
    return out;
  }, [query, commands, recent, entities.commands, pathname, boxes, navigate]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = flat[active];
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (active >= flat.length) setActive(flat.length ? flat.length - 1 : 0);
  }, [active, flat.length]);
  useEffect(() => warmCommand(current), [current]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Focus the input on open, give focus back on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const raf = requestAnimationFrame(() => input.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      prev?.focus?.();
    };
  }, []);

  const run = (c: Command | undefined) => {
    if (!c) return;
    if (c.id !== "act:search-mail") {
      const next = pushRecent(recent, { id: c.id, title: c.title, subtitle: c.subtitle, group: c.group, to: c.to });
      setRecent(next);
      saveRecent(next);
    }
    onClose();
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const sizes = groups.map((g) => g.items.length);
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) (e.preventDefault(), setActive((i) => moveIndex(i, 1, flat.length)));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) (e.preventDefault(), setActive((i) => moveIndex(i, -1, flat.length)));
    else if (e.key === "Tab") (e.preventDefault(), setActive((i) => jumpGroup(i, sizes, e.shiftKey ? -1 : 1)));
    else if (e.key === "Enter") (e.preventDefault(), run(current));
    else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose());
  };

  let index = -1;
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-start justify-center sm:px-4 sm:pt-[12vh]" onKeyDown={onKeyDown}>
      <div className="animate-fade absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="animate-in relative flex max-h-full w-full flex-col overflow-hidden border-line bg-raised shadow-ui-lg max-sm:h-full sm:max-h-[min(560px,76vh)] sm:max-w-[640px] sm:rounded-ui-lg sm:border"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-fg-muted" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={current ? `${id}-opt-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search pages, actions and people"
            placeholder={consoleRole ? "Search pages, actions, people, mailboxes…" : "Search pages and actions…"}
            className="h-13 min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-fg-faint focus:outline-none max-sm:h-14"
            autoComplete="off"
            spellCheck={false}
          />
          {entities.loading && <Spinner className="size-3.5" />}
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-ui-sm p-1 text-fg-muted hover:bg-muted hover:text-fg sm:hidden">
            <X className="size-5" />
          </button>
          <span className="max-sm:hidden">
            <Kbd>Esc</Kbd>
          </span>
        </div>
        <div ref={list} id={`${id}-list`} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {flat.length === 0 ? (
            <p className="px-3 py-10 text-center text-[13px] text-fg-muted">{query.trim() ? `Nothing matches "${query.trim()}".` : "Start typing to search."}</p>
          ) : (
            groups.map((g, gi) => (
              <div key={`${g.group}-${gi}`} role="group" aria-labelledby={`${id}-g-${gi}`} className="mb-1 last:mb-0">
                <p id={`${id}-g-${gi}`} className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">
                  {g.group}
                </p>
                {g.items.map((c) => {
                  index++;
                  const i = index;
                  const selected = i === active;
                  return (
                      <div
                        key={c.id}
                        id={`${id}-opt-${i}`}
                        data-index={i}
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => !selected && setActive(i)}
                        onClick={() => run(c)}
                        className={cx("flex cursor-pointer items-center gap-3 rounded-ui-sm px-2.5 py-2 text-[13px] max-sm:py-2.5", selected ? "bg-muted text-fg" : "text-fg")}
                      >
                        <span className={cx("flex size-7 shrink-0 items-center justify-center rounded-ui-sm border border-line", selected ? "bg-raised text-fg" : "bg-subtle text-fg-muted")}>
                          <c.icon className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            <Highlighted text={c.title} query={query} />
                          </span>
                          {c.subtitle && <span className="block truncate text-xs text-fg-faint">{c.subtitle}</span>}
                        </span>
                        {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
                        {selected && <span className="text-[11px] text-fg-faint max-sm:hidden">↵</span>}
                      </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-line bg-subtle px-4 py-2 text-[11px] text-fg-muted max-sm:hidden">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1"><Kbd>Tab</Kbd> next group</span>
          <span className="ml-auto flex items-center gap-1"><Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd><Kbd>K</Kbd> toggle</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
