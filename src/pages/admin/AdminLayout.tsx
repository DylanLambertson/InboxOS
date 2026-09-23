import { Navigate, useLocation } from "react-router";
import { Activity, Bot, Eye, Inbox, MailX, LayoutDashboard, Palette, Radar, Rocket, ScrollText, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { useMe } from "@/lib/queries";
import { SubNavLayout } from "@/components/layout/SubNav";

export function AdminLayout() {
  const { data: me } = useMe();
  const { pathname } = useLocation();
  if (me && me.role !== "owner" && me.role !== "admin" && me.role !== "manager") return <Navigate to="/" replace />;
  const manager = me?.role === "manager";
  // Managers have view-only access and don't see configuration pages.
  if (manager && /^\/admin\/(branding|settings|setup)/.test(pathname)) return <Navigate to="/admin" replace />;
  const all = [
        { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
        { to: "/admin/traffic", label: "All traffic", icon: Radar },
        { to: "/admin/users", label: "Users", icon: Users },
        { to: "/admin/mailboxes", label: "Mailboxes", icon: Inbox },
        { to: "/admin/security", label: "Security", icon: ShieldCheck },
        { to: "/admin/logs/delivery", label: "Delivery log", icon: Activity },
        { to: "/admin/logs/audit", label: "Audit log", icon: ScrollText },
        { to: "/admin/unsubscribes", label: "Unsubscribes", icon: MailX },
        { to: "/admin/branding", label: "Branding", icon: Palette },
        { to: "/admin/settings", label: "Settings & policy", icon: SlidersHorizontal },
        { to: "/admin/api", label: "API & MCP", icon: Bot },
        { to: "/admin/setup", label: "Setup guide", icon: Rocket },
  ];
  return (
    <SubNavLayout
      title="Admin console"
      items={manager ? all.filter((i) => !/branding|settings|setup/.test(i.to)) : all}
      footer={
        manager ? (
          <div className="mx-3 mb-3 flex items-start gap-2 rounded-ui border border-line bg-subtle p-3 text-xs text-fg-muted max-md:hidden">
            <Eye className="mt-0.5 size-3.5 shrink-0" />
            <span>You have <strong className="text-fg">view-only</strong> access as a manager.</span>
          </div>
        ) : undefined
      }
    />
  );
}
