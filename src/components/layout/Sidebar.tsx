import { useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  Archive,
  ChevronDown,
  Clock,
  File,
  Inbox,
  Inbox as Inboxes,
  LogOut,
  Mail,
  MailOpen,
  Monitor,
  Moon,
  PenSquare,
  Plus,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  Star,
  Sun,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import type { MailboxSummary } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { mailboxLabel } from "@/lib/format";
import { useLabels, useMailboxes, useMe } from "@/lib/queries";
import { toast } from "sonner";
import { clearAppCache } from "@/lib/pwa";
import { useCompose } from "../compose/ComposeProvider";
import { Avatar, Button, cx } from "../ui/primitives";
import { Menu } from "../ui/overlay";
import { Logo } from "./Logo";
import { LabelDialog } from "../mail/LabelDialog";

export const FOLDER_NAV = [
  { view: "inbox", label: "Inbox", icon: Inbox, count: "inbox" },
  { view: "starred", label: "Starred", icon: Star },
  { view: "sent", label: "Sent", icon: Send },
  { view: "drafts", label: "Drafts", icon: File, count: "drafts" },
  { view: "scheduled", label: "Scheduled", icon: Clock, count: "scheduled" },
  { view: "snoozed", label: "Snoozed", icon: AlarmClock, count: "snoozed" },
  { view: "all", label: "All mail", icon: Mail },
  { view: "archive", label: "Archive", icon: Archive },
  { view: "spam", label: "Spam", icon: ShieldAlert, count: "spam" },
  { view: "trash", label: "Trash", icon: Trash2 },
] as const;

/** Every mailbox the user can open, plus a unified "All inboxes" view. Switching keeps the current folder. */
function MailboxList({ boxes, currentId, onNavigate }: { boxes: MailboxSummary[]; currentId: string; onNavigate?: () => void }) {
  const { view = "inbox" } = useParams();
  const [expanded, setExpanded] = useState(false);
  const folder = view.startsWith("label:") ? "inbox" : view;
  const totalUnread = boxes.reduce((n, b) => n + (b.unread.inbox ?? 0), 0);
  const LIMIT = 6;
  const visible = expanded || boxes.length <= LIMIT ? boxes : boxes.filter((b, i) => i < LIMIT || b.id === currentId);
  const row = (id: string, label: string, sub: string, color: string | null, unread: number) => {
    const active = id === currentId;
    return (
      <Link
        key={id}
        to={`/mail/${id}/${folder}`}
        onClick={onNavigate}
        title={sub}
        className={cx(
          "flex h-8 items-center gap-2.5 rounded-ui-sm px-2.5 text-[13px] transition-colors",
          active ? "bg-muted font-medium text-fg" : "text-fg-muted hover:bg-muted hover:text-fg",
        )}
      >
        {color ? <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} /> : <Inboxes className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {!!unread && <span className="text-[11px] font-semibold tabular-nums text-accent">{unread > 999 ? "999+" : unread}</span>}
      </Link>
    );
  };
  return (
    <div className="mb-4">
      <div className="mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">Mailboxes</div>
      <div className="space-y-0.5">
        {boxes.length > 1 && row("all", "All inboxes", "Every mailbox you can access", null, totalUnread)}
        {visible.map((b) => row(b.id, mailboxLabel(b), b.address, b.color, b.unread.inbox ?? 0))}
        {boxes.length > LIMIT && (
          <button onClick={() => setExpanded((e) => !e)} className="flex h-7 w-full items-center gap-2.5 px-2.5 text-xs text-fg-muted hover:text-fg">
            <ChevronDown className={cx("size-3.5 transition", expanded && "rotate-180")} />
            {expanded ? "Show less" : `${boxes.length - visible.length} more`}
          </button>
        )}
      </div>
    </div>
  );
}

function NavItem({ to, icon: Icon, label, count, color, onNavigate }: { to: string; icon: typeof Inbox; label: string; count?: number; color?: string; onNavigate?: () => void }) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          "group flex h-8 items-center gap-2.5 rounded-ui-sm px-2.5 text-[13px] transition-colors",
          isActive ? "bg-accent-soft font-medium text-accent" : "text-fg-muted hover:bg-muted hover:text-fg",
        )
      }
    >
      {color ? <Tag className="size-4 shrink-0" style={{ color }} /> : <Icon className="size-4 shrink-0" />}
      <span className="flex-1 truncate">{label}</span>
      {!!count && <span className="text-[11px] font-semibold tabular-nums">{count > 999 ? "999+" : count}</span>}
    </NavLink>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { mailboxId } = useParams();
  const { data: boxes = [] } = useMailboxes();
  const { data: me } = useMe();
  const unified = mailboxId === "all" && boxes.length > 0;
  const current = unified ? undefined : boxes.find((b) => b.id === mailboxId) ?? boxes[0];
  const composeBox = current?.role !== "viewer" ? current : undefined;
  const fallbackCompose = boxes.find((b) => b.role !== "viewer");
  const sendFrom = composeBox ?? (unified ? fallbackCompose : undefined);
  const scopeId = unified ? "all" : current?.id;
  const unreadFor = (key: string) => (unified ? boxes.reduce((n, b) => n + (b.unread[key] ?? 0), 0) : current?.unread[key]);
  const { data: labels = [] } = useLabels(current?.id);
  const compose = useCompose();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [labelOpen, setLabelOpen] = useState(false);
  const isAdmin = me?.role === "owner" || me?.role === "admin" || me?.role === "manager";

  const setTheme = async (theme: "system" | "light" | "dark") => {
    try {
      const updated = await api.patch("me", { preferences: { theme } });
      qc.setQueryData(["me"], updated);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const logout = async () => {
    await api.post("/api/auth/logout");
    clearAppCache();
    qc.clear();
    navigate("/login");
  };

  return (
    <aside className="flex h-full w-full flex-col bg-subtle">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Link to="/" onClick={onNavigate}>
          <Logo />
        </Link>
      </div>

      <div className="px-3 pb-2">
        <Button
          variant="primary"
          className="w-full"
          icon={<PenSquare className="size-4" />}
          disabled={!sendFrom}
          onClick={() => (sendFrom && compose.open({ mailboxId: sendFrom.id }), onNavigate?.())}
        >
          Compose
        </Button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {scopeId && (
          <>
            <MailboxList boxes={boxes} currentId={scopeId} onNavigate={onNavigate} />
            <div className="mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">
              {unified ? "All inboxes" : current && mailboxLabel(current)}
            </div>
            <div className="space-y-0.5">
              {FOLDER_NAV.map((f) => (
                <NavItem
                  key={f.view}
                  to={`/mail/${scopeId}/${f.view}`}
                  icon={f.icon}
                  label={f.label}
                  count={"count" in f ? unreadFor(f.count) : undefined}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </>
        )}
        {current && (
          <>

            <div className="mt-5 mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-semibold tracking-wide text-fg-faint uppercase">Labels</span>
              {current.role !== "viewer" && (
                <button onClick={() => setLabelOpen(true)} className="rounded p-0.5 text-fg-faint hover:bg-muted hover:text-fg" aria-label="New label">
                  <Plus className="size-3.5" />
                </button>
              )}
            </div>
            <div className="space-y-0.5">
              {labels.map((l) => (
                <NavItem key={l.id} to={`/mail/${current.id}/label:${l.id}`} icon={Tag} color={l.color} label={l.name} onNavigate={onNavigate} />
              ))}
              {!labels.length && <p className="px-2.5 py-1 text-xs text-fg-faint">No labels yet</p>}
            </div>
          </>
        )}
        {!current && boxes.length === 0 && (
          <div className="rounded-ui border border-dashed border-line p-3 text-xs text-fg-muted">
            You don't have access to any mailboxes yet. Ask an administrator to add you to one.
          </div>
        )}
      </nav>

      <div className="border-t border-line p-2">
        {isAdmin && (
          <NavLink
            to="/admin"
            onClick={onNavigate}
            className={({ isActive }) => cx("mb-1 flex h-8 items-center gap-2.5 rounded-ui-sm px-2.5 text-[13px]", isActive ? "bg-muted text-fg" : "text-fg-muted hover:bg-muted hover:text-fg")}
          >
            <Shield className="size-4" /> Admin console
          </NavLink>
        )}
        {me && (
          <Menu
            width={240}
            header={
              <div className="border-b border-line px-2.5 pt-1.5 pb-2.5 mb-1">
                <p className="truncate text-[13px] font-medium">{me.name || me.email}</p>
                <p className="truncate text-xs text-fg-muted">{me.email}</p>
              </div>
            }
            items={[
              { label: "Settings", icon: <Settings />, onSelect: () => (navigate("/settings"), onNavigate?.()) },
              { label: "Contacts", icon: <Users />, onSelect: () => (navigate("/settings/contacts"), onNavigate?.()) },
              { separator: true, label: "" },
              { label: "System theme", icon: <Monitor />, checked: me.preferences.theme === "system", onSelect: () => setTheme("system") },
              { label: "Light", icon: <Sun />, checked: me.preferences.theme === "light", onSelect: () => setTheme("light") },
              { label: "Dark", icon: <Moon />, checked: me.preferences.theme === "dark", onSelect: () => setTheme("dark") },
              { separator: true, label: "" },
              { label: "Keyboard shortcuts", icon: <MailOpen />, shortcut: "?", onSelect: () => window.dispatchEvent(new CustomEvent("io:shortcuts")) },
              { label: "Sign out", icon: <LogOut />, onSelect: logout },
            ]}
            trigger={(p) => (
              <button {...p} className="flex w-full items-center gap-2.5 rounded-ui-sm px-2 py-1.5 text-left hover:bg-muted">
                <Avatar name={me.name} email={me.email} color={me.avatarColor} size={26} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{me.name || me.email}</span>
              </button>
            )}
          />
        )}
      </div>
      {current && <LabelDialog open={labelOpen} onClose={() => setLabelOpen(false)} mailboxId={current.id} />}
    </aside>
  );
}
