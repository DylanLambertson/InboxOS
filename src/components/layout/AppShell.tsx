import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { Menu as MenuIcon, PenSquare, ShieldAlert } from "lucide-react";
import { applyTheme } from "@/lib/brand";
import { useInboxNotifications } from "@/lib/notifications";
import { useMailboxes, useMe } from "@/lib/queries";
import { SHORTCUT_HELP, useShortcuts } from "@/lib/shortcuts";
import { ComposeProvider, useCompose } from "../compose/ComposeProvider";
import { IconButton, Kbd, Spinner } from "../ui/primitives";
import { Modal } from "../ui/overlay";
import { Logo } from "./Logo";
import { Sidebar } from "./Sidebar";

/** Signed-in layout: auth gate, sidebar, compose windows, global shortcuts. */
export function AppShell() {
  const { data: me, isLoading, error } = useMe();
  const { data: boxes = [] } = useMailboxes();
  useInboxNotifications(me, boxes);
  const location = useLocation();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    const onHelp = () => setHelp(true);
    window.addEventListener("io:unauthorized", onUnauthorized);
    window.addEventListener("io:shortcuts", onHelp);
    return () => {
      window.removeEventListener("io:unauthorized", onUnauthorized);
      window.removeEventListener("io:shortcuts", onHelp);
    };
  }, [navigate, location]);

  useEffect(() => {
    if (me) applyTheme(me.preferences.theme);
  }, [me]);
  useEffect(() => setDrawer(false), [location.pathname]);
  useShortcuts({ "?": () => setHelp(true) }, []);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (error || !me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  // Organization requires 2FA: keep the user on the security page until enrolled.
  if (me.mustEnroll2fa && location.pathname !== "/settings/security") return <Navigate to="/settings/security" replace />;

  return (
    <ComposeProvider>
      <div className="flex h-full">
        <div className="hidden w-60 shrink-0 border-r border-line md:block">
          <Sidebar />
        </div>
        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="animate-fade absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <div className="animate-in absolute inset-y-0 left-0 w-72 border-r border-line shadow-ui-lg">
              <Sidebar onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 md:hidden">
            <IconButton label="Menu" onClick={() => setDrawer(true)}>
              <MenuIcon className="size-5" />
            </IconButton>
            <Logo size={24} />
          </div>
          {me.mustEnroll2fa && (
            <div className="flex items-center gap-2 border-b border-warning/30 bg-warning-soft px-4 py-2 text-[13px] text-warning">
              <ShieldAlert className="size-4" /> Your organization requires two-factor authentication. Set it up below to continue.
            </div>
          )}
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </main>
        <MobileComposeButton />
      </div>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" width={520}>
        <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
          {SHORTCUT_HELP.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="text-fg-muted">{d}</span>
              <Kbd>{k}</Kbd>
            </div>
          ))}
        </div>
      </Modal>
    </ComposeProvider>
  );
}

/** Floating compose button on phones, where the sidebar's Compose button is tucked into the drawer. */
function MobileComposeButton() {
  const { data: boxes = [] } = useMailboxes();
  const compose = useCompose();
  const location = useLocation();
  const routeBox = location.pathname.match(/^\/mail\/([^/]+)/)?.[1];
  const writable = boxes.filter((b) => b.role !== "viewer");
  const from = writable.find((b) => b.id === routeBox) ?? writable[0];
  if (!from || !location.pathname.startsWith("/mail")) return null;
  return (
    <button
      type="button"
      aria-label="Compose"
      onClick={() => compose.open({ mailboxId: from.id })}
      className="fixed right-4 z-40 flex size-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-ui-lg active:brightness-95 md:hidden"
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <PenSquare className="size-5" />
    </button>
  );
}
