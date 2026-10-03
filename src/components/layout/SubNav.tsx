import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { ChevronRight, ChevronsUpDown, Search, type LucideIcon } from "lucide-react";
import { useBrand } from "@/lib/brand";
import { prefetchRoute } from "@/lib/route-chunks";
import { cx, Kbd } from "../ui/primitives";
import { Modal } from "../ui/overlay";

export interface SubNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Small count on the right, e.g. open health issues. */
  badge?: { count: number; tone?: "danger" | "warning" | "neutral"; label?: string };
}

export interface SubNavGroup {
  id: string;
  label: string;
  items: SubNavItem[];
}

const isActive = (it: SubNavItem, path: string) => (it.end ? path === it.to : path === it.to || path.startsWith(`${it.to}/`));

/** Longest matching item, so /admin/logs/audit doesn't also light up /admin. */
function activeOf(groups: SubNavGroup[], path: string): { group: SubNavGroup; item: SubNavItem } | null {
  let best: { group: SubNavGroup; item: SubNavItem } | null = null;
  for (const group of groups) for (const item of group.items) if (isActive(item, path) && (!best || item.to.length > best.item.to.length)) best = { group, item };
  return best;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const openCommandPalette = () => window.dispatchEvent(new CustomEvent("io:palette"));

function Badge({ badge }: { badge: NonNullable<SubNavItem["badge"]> }) {
  if (!badge.count) return null;
  const tone = badge.tone ?? "neutral";
  return (
    <span
      aria-label={badge.label ?? `${badge.count}`}
      className={cx(
        "ml-auto inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
        tone === "danger" ? "bg-danger text-white" : tone === "warning" ? "bg-warning-soft text-warning" : "bg-muted text-fg-muted",
      )}
    >
      {badge.count > 99 ? "99+" : badge.count}
    </span>
  );
}

function Item({ it, onNavigate, chip }: { it: SubNavItem; onNavigate?: () => void; chip?: boolean }) {
  const warm = () => prefetchRoute(it.to);
  return (
    <NavLink
      to={it.to}
      end={it.end}
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      onClick={onNavigate}
      className={({ isActive: active }) =>
        cx(
          "flex shrink-0 items-center gap-2.5 rounded-ui-sm px-2.5 text-[13px] whitespace-nowrap transition-colors",
          chip ? "h-8 max-md:h-9" : "h-8 max-md:h-10",
          active ? "bg-muted font-medium text-fg" : "text-fg-muted hover:bg-muted hover:text-fg",
        )
      }
    >
      <it.icon className="size-4 shrink-0" />
      <span className="truncate">{it.label}</span>
      {it.badge && <Badge badge={it.badge} />}
    </NavLink>
  );
}

function SearchButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className={cx(
        "flex h-8 w-full items-center gap-2 rounded-ui border border-line bg-surface px-2.5 text-[13px] text-fg-muted shadow-ui-sm transition-colors hover:border-line-strong hover:text-fg",
        className,
      )}
    >
      <Search className="size-3.5" />
      <span className="flex-1 text-left">Search…</span>
      <span className="flex gap-0.5 max-md:hidden">
        <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}

/** Phones: a picker for the whole section list, plus the current group's pages as chips. */
function MobileNav({ title, groups, flat }: { title: string; groups: SubNavGroup[]; flat: boolean }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const active = activeOf(groups, pathname);
  const chips = flat ? groups[0]?.items ?? [] : active?.group.items ?? [];
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    row.current?.querySelector<HTMLElement>("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);
  return (
    <div className="md:hidden">
      {!flat && (
        <div className="flex items-center gap-2 px-3 pt-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-ui border border-line bg-surface px-3 text-left text-[13px] shadow-ui-sm"
          >
            <span className="truncate text-fg-muted">{active?.group.label ?? title}</span>
            <ChevronRight className="size-3.5 shrink-0 text-fg-faint" />
            <span className="truncate font-medium">{active?.item.label ?? "Choose a page"}</span>
            <ChevronsUpDown className="ml-auto size-4 shrink-0 text-fg-muted" />
          </button>
          <button type="button" onClick={openCommandPalette} aria-label="Search" className="flex size-10 shrink-0 items-center justify-center rounded-ui border border-line bg-surface text-fg-muted shadow-ui-sm">
            <Search className="size-4" />
          </button>
        </div>
      )}
      {chips.length > 1 && (
        <div ref={row} className="flex snap-x gap-0.5 overflow-x-auto p-2 [scrollbar-width:none]">
          {chips.map((it) => (
            <div key={it.to} className="snap-start">
              <Item it={it} chip />
            </div>
          ))}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={title} width={420}>
        <nav aria-label={title} className="space-y-4">
          {groups.map((g) => (
            <div key={g.id}>
              <p className="mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{g.label}</p>
              <div className="space-y-0.5">
                {g.items.map((it) => (
                  <Item key={it.to} it={it} onNavigate={() => setOpen(false)} />
                ))}
              </div>
            </div>
          ))}
        </nav>
      </Modal>
    </div>
  );
}

/**
 * Two-column page with a section nav, used by Settings and the Admin console.
 * Pass flat `items`, or `groups` for a sectioned nav with breadcrumbs.
 */
export function SubNavLayout({
  title,
  items,
  groups: groupsProp,
  footer,
  search,
  actions,
}: {
  title: string;
  items?: SubNavItem[];
  groups?: SubNavGroup[];
  footer?: ReactNode;
  /** Show a "Search… ⌘K" button that opens the command palette. */
  search?: boolean;
  /** Extra controls in the header row above the page (right side). */
  actions?: ReactNode;
}) {
  const flat = !groupsProp;
  const groups: SubNavGroup[] = groupsProp ?? [{ id: "main", label: title, items: items ?? [] }];
  const { pathname } = useLocation();
  const active = activeOf(groups, pathname);
  const productName = useBrand().productName;

  useEffect(() => {
    if (!active) return;
    document.title = `${active.item.label} · ${productName}`;
    return () => void (document.title = productName);
  }, [active?.item.label, productName]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full min-w-0 max-md:flex-col">
      <nav aria-label={title} className="shrink-0 border-line md:flex md:w-60 md:flex-col md:border-r max-md:border-b">
        <div className="hidden h-14 shrink-0 items-center px-5 md:flex">
          <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        </div>
        {search && (
          <div className="hidden px-3 pb-3 md:block">
            <SearchButton />
          </div>
        )}
        <div className="hidden min-h-0 flex-1 overflow-y-auto px-3 pb-3 md:block">
          {flat ? (
            <div className="flex flex-col gap-0.5">
              {groups[0].items.map((it) => (
                <Item key={it.to} it={it} />
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.id} role="group" aria-labelledby={`subnav-${g.id}`}>
                  <p id={`subnav-${g.id}`} className="mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">
                    {g.label}
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {g.items.map((it) => (
                      <Item key={it.to} it={it} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <MobileNav title={title} groups={groups} flat={flat} />
        {footer}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          {!flat && active && (
            <div className="mb-3 flex items-center gap-3 max-md:hidden">
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
                <span>{title}</span>
                <ChevronRight className="size-3 text-fg-faint" />
                <span>{active.group.label}</span>
                <ChevronRight className="size-3 text-fg-faint" />
                <span aria-current="page" className="truncate font-medium text-fg">
                  {active.item.label}
                </span>
              </nav>
              {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
            </div>
          )}
          <Outlet />
        </div>
      </div>
    </div>
  );
}
