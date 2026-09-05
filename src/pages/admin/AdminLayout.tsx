import { Navigate } from "react-router";
import { Activity, Inbox, LayoutDashboard, Palette, Radar, Rocket, ScrollText, SlidersHorizontal, Users } from "lucide-react";
import { useMe } from "@/lib/queries";
import { SubNavLayout } from "@/components/layout/SubNav";

export function AdminLayout() {
  const { data: me } = useMe();
  if (me && me.role !== "owner" && me.role !== "admin") return <Navigate to="/" replace />;
  return (
    <SubNavLayout
      title="Admin console"
      items={[
        { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
        { to: "/admin/traffic", label: "All traffic", icon: Radar },
        { to: "/admin/users", label: "Users", icon: Users },
        { to: "/admin/mailboxes", label: "Mailboxes", icon: Inbox },
        { to: "/admin/logs/delivery", label: "Delivery log", icon: Activity },
        { to: "/admin/logs/audit", label: "Audit log", icon: ScrollText },
        { to: "/admin/branding", label: "Branding", icon: Palette },
        { to: "/admin/settings", label: "Settings & policy", icon: SlidersHorizontal },
        { to: "/admin/setup", label: "Setup guide", icon: Rocket },
      ]}
    />
  );
}
