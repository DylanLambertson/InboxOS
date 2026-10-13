import { useEffect } from "react";
import { Archive, Inbox, PenSquare, Reply, Send, Star, Trash2 } from "lucide-react";
import type { Brand } from "@shared/brand";
import type { ThemeTokens } from "@shared/theme";
import { cx } from "@/components/ui/primitives";
import { ensurePreviewFont, scopedThemeStyle, type Mode } from "./theme-utils";

const ROWS = [
  { from: "Priya Natarajan", subject: "Kickoff notes and next steps", snippet: "Thanks all, here's a recap of what we agreed…", time: "9:41", unread: true, color: "#0ea5e9" },
  { from: "Billing", subject: "Invoice #1042 is ready", snippet: "Your invoice for October is attached.", time: "8:15", unread: true, color: "#f59e0b" },
  { from: "Marco Rossi", subject: "Re: Homepage copy", snippet: "Looks great. One small tweak on the hero…", time: "Yesterday", unread: false, color: "#10b981" },
  { from: "Lena Vogel", subject: "Contract signed", snippet: "All done! Countersigned copy attached.", time: "Mon", unread: false, color: "#8b5cf6" },
];

const pad = (px: number) => `calc(${px}px * var(--density))`;

/** A miniature of the mail app in one color mode, styled only by the given theme. */
export function MiniMail({ theme, brand, mode }: { theme: ThemeTokens; brand: Pick<Brand, "productName" | "monogram" | "logoUrl">; mode: Mode }) {
  useEffect(() => ensurePreviewFont(theme.googleFont), [theme.googleFont]);
  return (
    <div
      style={scopedThemeStyle(theme, mode)}
      className="pointer-events-none overflow-hidden rounded-ui-lg border border-line shadow-ui-md select-none"
      aria-hidden
    >
      <div className="flex h-[300px] text-[0.86em]">
        {/* Sidebar */}
        <div className="flex w-[30%] min-w-0 flex-col border-r border-line bg-subtle p-2.5">
          <div className="mb-3 flex items-center gap-2 px-1">
            {brand.logoUrl ? (
              <img src={brand.logoUrl} alt="" className="size-5 rounded-ui-sm object-contain" />
            ) : (
              <span className="flex size-5 items-center justify-center rounded-ui-sm bg-accent text-[0.6em] font-bold text-accent-fg">{brand.monogram}</span>
            )}
            <span className="truncate font-semibold">{brand.productName}</span>
          </div>
          <div className="mb-2.5 flex items-center justify-center gap-1.5 rounded-ui bg-accent font-medium text-accent-fg shadow-ui-sm" style={{ paddingBlock: pad(6) }}>
            <PenSquare className="size-3" /> Compose
          </div>
          {[
            { icon: Inbox, label: "Inbox", count: 2, active: true },
            { icon: Star, label: "Starred" },
            { icon: Send, label: "Sent" },
            { icon: Archive, label: "Archive" },
            { icon: Trash2, label: "Trash" },
          ].map((n) => (
            <div
              key={n.label}
              className={cx("flex items-center gap-2 rounded-ui-sm px-2", n.active ? "bg-accent-soft font-medium text-accent-ink" : "text-fg-muted")}
              style={{ paddingBlock: pad(4) }}
            >
              <n.icon className="size-3 shrink-0" />
              <span className="flex-1 truncate">{n.label}</span>
              {n.count && <span className="text-[0.85em] font-semibold">{n.count}</span>}
            </div>
          ))}
          <div className="mt-auto flex items-center gap-2 px-1 pt-2">
            <span className="size-5 rounded-full" style={{ background: "#6366f1" }} />
            <span className="truncate text-fg-muted">Alex Kim</span>
          </div>
        </div>

        {/* List */}
        <div className="w-[36%] min-w-0 border-r border-line bg-bg">
          <div className="border-b border-line px-2.5 py-2">
            <div className="rounded-ui border border-line bg-surface px-2 py-1 text-fg-faint">Search mail</div>
          </div>
          {ROWS.map((r, i) => (
            <div key={r.subject} className={cx("relative flex gap-2 border-b border-line px-2.5", i === 0 ? "bg-accent-soft" : "")} style={{ paddingBlock: pad(7) }}>
              {r.unread && <span className="absolute top-1/2 left-1 size-1 -translate-y-1/2 rounded-full bg-accent-ink" />}
              <span className="mt-0.5 size-5 shrink-0 rounded-full" style={{ background: r.color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1">
                  <span className={cx("flex-1 truncate", r.unread ? "font-semibold text-fg" : "text-fg")}>{r.from}</span>
                  <span className="shrink-0 text-[0.8em] text-fg-faint">{r.time}</span>
                </div>
                <div className={cx("truncate", r.unread ? "font-medium" : "text-fg-muted")}>{r.subject}</div>
                <div className="truncate text-[0.9em] text-fg-faint">{r.snippet}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Reading pane */}
        <div className="flex min-w-0 flex-1 flex-col bg-bg p-3">
          <div className="mb-1 font-semibold">Kickoff notes and next steps</div>
          <div className="mb-3 flex items-center gap-1.5">
            <span className="rounded-full bg-success-soft px-1.5 text-[0.8em] font-medium text-success">Open</span>
            <span className="rounded-full bg-accent-soft px-1.5 text-[0.8em] font-medium text-accent-ink">Client</span>
          </div>
          <div className="rounded-ui border border-line bg-surface p-2.5 shadow-ui-sm">
            <div className="mb-2 flex items-center gap-2">
              <span className="size-5 rounded-full" style={{ background: "#0ea5e9" }} />
              <div className="min-w-0">
                <div className="truncate font-medium">Priya Natarajan</div>
                <div className="truncate text-[0.85em] text-fg-muted">to me, Marco</div>
              </div>
            </div>
            <p className="text-fg">Thanks all, here's a recap of what we agreed today.</p>
            <p className="mt-1 text-fg-muted">
              Next review is Thursday. <span className="text-accent-ink underline">Open the brief</span>
            </p>
          </div>
          <div className="mt-auto flex gap-1.5 pt-3">
            <span className="inline-flex items-center gap-1 rounded-ui border border-line bg-surface px-2 py-1 font-medium shadow-ui-sm">
              <Reply className="size-3" /> Reply
            </span>
            <span className="inline-flex items-center gap-1 rounded-ui bg-accent px-2 py-1 font-medium text-accent-fg shadow-ui-sm">
              <Send className="size-3" /> Send
            </span>
            <span className="ml-auto rounded-ui bg-danger-soft px-2 py-1 font-medium text-danger">Delete</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Light and dark previews side by side (stacked on narrow screens). */
export function ThemePreview({ theme, brand }: { theme: ThemeTokens; brand: Pick<Brand, "productName" | "monogram" | "logoUrl"> }) {
  return (
    <div className="grid gap-4 2xl:grid-cols-2">
      {(["light", "dark"] as const).map((mode) => (
        <figure key={mode} className="min-w-0">
          <figcaption className="mb-1.5 text-xs font-medium text-fg-muted">{mode === "light" ? "Light" : "Dark"}</figcaption>
          <MiniMail theme={theme} brand={brand} mode={mode} />
        </figure>
      ))}
    </div>
  );
}
