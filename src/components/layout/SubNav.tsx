import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router";
import type { LucideIcon } from "lucide-react";
import { cx } from "../ui/primitives";

export interface SubNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

/** Two-column page with a section nav — used by Settings and the Admin console. */
export function SubNavLayout({ title, items, footer }: { title: string; items: SubNavItem[]; footer?: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 max-md:flex-col">
      <nav className="shrink-0 border-line md:w-56 md:border-r max-md:border-b">
        <div className="hidden h-14 items-center px-5 md:flex">
          <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        </div>
        <div className="flex gap-0.5 overflow-x-auto p-2 md:flex-col md:p-3 md:pt-0">
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                cx(
                  "flex h-8 shrink-0 items-center gap-2.5 rounded-ui-sm px-2.5 text-[13px] whitespace-nowrap transition-colors",
                  isActive ? "bg-muted font-medium text-fg" : "text-fg-muted hover:bg-muted hover:text-fg",
                )
              }
            >
              <it.icon className="size-4" />
              {it.label}
            </NavLink>
          ))}
        </div>
        {footer}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
