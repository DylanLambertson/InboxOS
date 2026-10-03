import { Navigate, useLocation } from "react-router";
import { Eye } from "lucide-react";
import { healthIssueCount } from "@shared/health";
import { DEFAULT_WORKSPACE } from "@shared/workspace";
import { useMe } from "@/lib/queries";
import { useWorkspace } from "@/lib/workspace";
import { featureForPath, isConfigPath, visibleAdminNav } from "@/lib/admin-nav";
import { SubNavLayout, type SubNavGroup } from "@/components/layout/SubNav";
import { useHealth } from "./health-data";

export function AdminLayout() {
  const { data: me } = useMe();
  const { pathname } = useLocation();
  const workspace = useWorkspace();
  const features = (workspace.data ?? DEFAULT_WORKSPACE).features;
  const consoleRole = me?.role === "owner" || me?.role === "admin" || me?.role === "manager";
  const { data: health } = useHealth(!!me && consoleRole);

  if (me && !consoleRole) return <Navigate to="/" replace />;
  const manager = me?.role === "manager";
  // Managers have view-only access and don't see configuration pages.
  if (manager && isConfigPath(pathname)) return <Navigate to="/admin" replace />;
  // A switched-off feature's pages go away with it (once the real setting has loaded).
  const feature = featureForPath(pathname);
  if (feature && !workspace.isPlaceholderData && !features[feature]) return <Navigate to="/admin" replace />;

  const issues = healthIssueCount(health);
  const groups: SubNavGroup[] = visibleAdminNav(me?.role, features).map((g) => ({
    id: g.id,
    label: g.label,
    items: g.items.map((i) => ({
      to: i.to,
      label: i.label,
      icon: i.icon,
      end: i.end,
      badge:
        i.to === "/admin/health" && issues
          ? { count: issues, tone: health?.counts.fail ? "danger" : "warning", label: `${issues} issue${issues === 1 ? "" : "s"}` }
          : undefined,
    })),
  }));

  return (
    <SubNavLayout
      title="Admin console"
      groups={groups}
      search
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
