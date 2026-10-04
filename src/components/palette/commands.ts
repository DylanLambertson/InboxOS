import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlarmClock,
  Archive,
  AtSign,
  Clock,
  File,
  FileText,
  HeartPulse,
  Inbox,
  Keyboard,
  LogOut,
  Mail,
  Monitor,
  Moon,
  PenSquare,
  Plus,
  Rocket,
  Search,
  Send,
  Shield,
  ShieldAlert,
  Star,
  Sun,
  Trash2,
  User,
  UserPlus,
  UserRound,
  UserRoundX,
  Users,
  SwatchBook,
  type LucideIcon,
} from "lucide-react";
import type { ThemePreference } from "@shared/types";
import { DEFAULT_WORKSPACE, type FeatureKey } from "@shared/workspace";
import { api, errorMessage } from "@/lib/api";
import { canManageRole, visibleAdminNav } from "@/lib/admin-nav";
import { mailboxLabel } from "@/lib/format";
import type { PaletteEntry } from "@/lib/palette-match";
import { disablePush } from "@/lib/push";
import { clearAppCache } from "@/lib/pwa";
import { useMailboxes, useMe } from "@/lib/queries";
import { prefetchRoute } from "@/lib/route-chunks";
import { useWorkspace } from "@/lib/workspace";
import { useCompose } from "../compose/ComposeProvider";

export interface Command extends PaletteEntry {
  icon: LucideIcon;
  /** Navigation target, also used to warm the page's chunk while highlighted. */
  to?: string;
  run: () => void;
  shortcut?: string;
}

export const GROUPS = { actions: "Actions", mail: "Mail", mailboxes: "Mailboxes", settings: "Settings", admin: "Admin console" } as const;

const MAIL_VIEWS: { view: string; label: string; icon: LucideIcon; feature?: FeatureKey; keywords?: string[]; all?: boolean }[] = [
  { view: "inbox", label: "Inbox", icon: Inbox },
  { view: "starred", label: "Starred", icon: Star },
  { view: "sent", label: "Sent", icon: Send },
  { view: "drafts", label: "Drafts", icon: File },
  { view: "scheduled", label: "Scheduled", icon: Clock, feature: "scheduledSend" },
  { view: "snoozed", label: "Snoozed", icon: AlarmClock, feature: "snooze" },
  { view: "all", label: "All mail", icon: Mail },
  { view: "archive", label: "Archive", icon: Archive },
  { view: "spam", label: "Spam", icon: ShieldAlert, keywords: ["junk"] },
  { view: "trash", label: "Trash", icon: Trash2, keywords: ["deleted", "bin"] },
  { view: "assigned", label: "Assigned to me", icon: UserRound, feature: "collaboration", all: true },
  { view: "mentions", label: "Mentions", icon: AtSign, feature: "collaboration", all: true },
  { view: "unassigned", label: "Unassigned", icon: UserRoundX, feature: "collaboration" },
];

const SETTINGS: { to: string; label: string; icon: LucideIcon; feature?: FeatureKey; keywords?: string[] }[] = [
  { to: "/settings/profile", label: "Profile & preferences", icon: User, keywords: ["name", "signature", "density", "undo send", "digest", "notifications"] },
  { to: "/settings/mailboxes", label: "My mailboxes", icon: Inbox, keywords: ["auto-reply", "vacation", "rules", "signature"] },
  { to: "/settings/security", label: "My security", icon: Shield, keywords: ["password", "2fa", "passkeys", "authenticator", "sessions"] },
  { to: "/settings/templates", label: "Templates", icon: FileText, feature: "templates", keywords: ["canned replies", "snippets"] },
  { to: "/settings/contacts", label: "Contacts", icon: Users, feature: "contacts", keywords: ["address book", "people"] },
];

/** Whether the page is showing dark colors right now. */
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
};

/** Everything the palette can do for this person, already filtered by role and features. */
export function usePaletteCommands(): Command[] {
  const { data: me } = useMe();
  const { data: boxes = [] } = useMailboxes();
  const features = (useWorkspace().data ?? DEFAULT_WORKSPACE).features;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const compose = useCompose();
  const qc = useQueryClient();

  return useMemo(() => {
    if (!me) return [];
    const go = (to: string) => () => navigate(to);
    const routeBox = pathname.match(/^\/mail\/([^/]+)/)?.[1];
    const scope = routeBox && (routeBox === "all" || boxes.some((b) => b.id === routeBox)) ? routeBox : boxes.length > 1 ? "all" : boxes[0]?.id;
    const writable = boxes.filter((b) => b.role !== "viewer");
    const composeFrom = writable.find((b) => b.id === routeBox) ?? writable[0];
    const on = (f?: FeatureKey) => !f || features[f];
    const out: Command[] = [];

    // ---- Actions
    if (composeFrom) {
      out.push({ id: "act:compose", title: "Compose", subtitle: `From ${composeFrom.address}`, group: GROUPS.actions, icon: PenSquare, keywords: ["new email", "write", "message"], shortcut: "C", run: () => compose.open({ mailboxId: composeFrom.id }) });
    }
    const setTheme = async (theme: ThemePreference) => {
      try {
        qc.setQueryData(["me"], await api.patch("me", { preferences: { theme } }));
      } catch (e) {
        toast.error(errorMessage(e));
      }
    };
    const dark = isDark();
    out.push({ id: "act:theme", title: dark ? "Switch to light mode" : "Switch to dark mode", group: GROUPS.actions, icon: dark ? Sun : Moon, keywords: ["theme", "appearance", "toggle", "dark", "light"], run: () => void setTheme(dark ? "light" : "dark") });
    if (me.preferences.theme !== "system") {
      out.push({ id: "act:theme-system", title: "Match system theme", group: GROUPS.actions, icon: Monitor, keywords: ["theme", "auto", "appearance"], run: () => void setTheme("system") });
    }
    if (me.preferences.theme !== "workspace") {
      out.push({ id: "act:theme-workspace", title: "Use the workspace color mode", group: GROUPS.actions, icon: SwatchBook, keywords: ["theme", "default", "appearance"], run: () => void setTheme("workspace") });
    }
    out.push({ id: "act:shortcuts", title: "Keyboard shortcuts", group: GROUPS.actions, icon: Keyboard, keywords: ["help", "keys", "hotkeys"], shortcut: "?", run: () => window.dispatchEvent(new CustomEvent("io:shortcuts")) });
    const consoleRole = me.role === "owner" || me.role === "admin" || me.role === "manager";
    if (canManageRole(me.role)) {
      out.push(
        { id: "act:invite", title: "Invite a user", group: GROUPS.actions, icon: UserPlus, keywords: ["add person", "new user", "teammate"], to: "/admin/users?new=1", run: go("/admin/users?new=1") },
        { id: "act:new-mailbox", title: "Create a mailbox", group: GROUPS.actions, icon: Plus, keywords: ["new mailbox", "shared inbox", "address"], to: "/admin/mailboxes?new=1", run: go("/admin/mailboxes?new=1") },
        { id: "act:setup", title: "Open setup", group: GROUPS.actions, icon: Rocket, keywords: ["wizard", "getting started", "provider"], to: "/admin/setup", run: go("/admin/setup") },
      );
    }
    if (consoleRole) out.push({ id: "act:health", title: "Check system health", group: GROUPS.actions, icon: HeartPulse, keywords: ["status", "diagnostics", "problems"], to: "/admin/health", run: go("/admin/health") });
    out.push({
      id: "act:signout",
      title: "Sign out",
      group: GROUPS.actions,
      icon: LogOut,
      keywords: ["log out", "logout"],
      run: async () => {
        await disablePush().catch(() => undefined);
        await api.post("/api/auth/logout").catch(() => undefined);
        clearAppCache();
        qc.clear();
        navigate("/login");
      },
    });

    // ---- Mail views and mailboxes
    if (scope) {
      for (const v of MAIL_VIEWS) {
        if (!on(v.feature)) continue;
        const to = `/mail/${v.all ? "all" : scope}/${v.view}`;
        out.push({ id: `mail:${v.view}`, title: v.label, subtitle: "Go to", group: GROUPS.mail, icon: v.icon, keywords: v.keywords, to, run: go(to) });
      }
    }
    if (boxes.length > 1) out.push({ id: "box:all", title: "All inboxes", subtitle: "Every mailbox you can access", group: GROUPS.mailboxes, icon: Inbox, to: "/mail/all/inbox", run: go("/mail/all/inbox") });
    for (const b of boxes) {
      const to = `/mail/${b.id}/inbox`;
      out.push({ id: `box:${b.id}`, title: mailboxLabel(b), subtitle: b.address, group: GROUPS.mailboxes, icon: Inbox, keywords: [b.address], to, run: go(to) });
    }

    // ---- People, settings and admin pages
    out.push({ id: "page:people", title: "People", subtitle: "Team directory", group: GROUPS.settings, icon: Users, keywords: ["team", "directory", "colleagues", "teammates", "who"], to: "/people", run: go("/people") });
    for (const s of SETTINGS) {
      if (!on(s.feature)) continue;
      out.push({ id: `settings:${s.to}`, title: s.label, subtitle: "Settings", group: GROUPS.settings, icon: s.icon, keywords: s.keywords, to: s.to, run: go(s.to) });
    }
    if (consoleRole) {
      for (const g of visibleAdminNav(me.role, features)) {
        for (const i of g.items) {
          out.push({ id: `admin:${i.to}`, title: i.label, subtitle: g.label, group: GROUPS.admin, icon: i.icon, keywords: [...(i.keywords ?? []), "admin"], to: i.to, run: go(i.to), boost: 1 });
        }
      }
    }
    return out;
  }, [me, boxes, features, pathname, navigate, compose, qc]);
}

/** "Search mail for …", the first suggestion whenever something is typed. */
export function searchMailCommand(query: string, scope: string | undefined, navigate: (to: string) => void): Command | null {
  const q = query.trim();
  if (!q || !scope) return null;
  const to = `/mail/${scope}/all?q=${encodeURIComponent(q)}`;
  return { id: "act:search-mail", title: `Search mail for "${q}"`, group: GROUPS.actions, icon: Search, to, run: () => navigate(to) };
}

/** Warm a command's page while it's highlighted. */
export const warmCommand = (c: Command | undefined) => void (c?.to && prefetchRoute(c.to));
