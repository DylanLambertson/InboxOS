import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { Menu as MenuIcon, PenSquare, Search, ShieldAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { applyDensity, applyTheme, useBrand } from "@/lib/brand";
import { useInboxNotifications } from "@/lib/notifications";
import { syncPush } from "@/lib/push";
import { useFeature } from "@/lib/workspace";
import { useMailboxes, useMe } from "@/lib/queries";
import { SHORTCUT_HELP, useShortcuts } from "@/lib/shortcuts";
import { ComposeProvider, useCompose } from "../compose/ComposeProvider";
import { IconButton, Kbd, Spinner } from "../ui/primitives";
import { Modal } from "../ui/overlay";
import { PaletteHost } from "../palette/PaletteHost";
import { InstallPrompt } from "./InstallPrompt";
import { SetupBanner } from "../setup/SetupBanner";
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

  const { defaultMode, density: defaultDensity } = useBrand().theme;
  useEffect(() => {
    if (me) applyTheme(me.preferences.theme, defaultMode);
  }, [me, defaultMode]);
  useEffect(() => {
    if (me) applyDensity(me.preferences.density, defaultDensity);
  }, [me, defaultDensity]);
  // Keep this device's push subscription registered to whoever is signed in (while push is on).
  const pushOn = useFeature("push");
  useEffect(() => {
    if (me?.id && pushOn) syncPush();
  }, [me?.id, pushOn]);
  useEffect(() => setDrawer(false), [location.pathname]);
  useShortcuts({ "?": () => setHelp(true) }, []);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  // Refused by the IP allowlist: the session is fine, the network isn't, so explain instead of
  // bouncing to the sign-in page (which would send a signed-in user straight back here).
  if (error instanceof ApiError && error.status === 403) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <ShieldAlert className="size-8 text-warning" />
        <p className="max-w-sm text-sm text-fg-muted">{error.message}</p>
        <button
          className="h-8 rounded-ui border border-line bg-surface px-3 text-[13px] font-medium hover:bg-subtle"
          onClick={async () => {
            await api.post("/api/auth/logout").catch(() => {});
            window.location.assign("/login");
          }}
        >
          Sign out
        </button>
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
          <div className="fixed inset-0 z-50 md:hidden" style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
            <div className="animate-fade absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <div className="animate-in absolute inset-y-0 left-0 w-72 border-r border-line shadow-ui-lg">
              <Sidebar onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <div
            className="flex shrink-0 items-center gap-2 border-b border-line px-2 md:hidden"
            // Installed on a phone, the app runs full-screen: keep the bar clear of the notch / status bar.
            style={{ paddingTop: "env(safe-area-inset-top, 0px)", minHeight: "calc(3rem + env(safe-area-inset-top, 0px))" }}
          >
            <IconButton label="Menu" onClick={() => setDrawer(true)}>
              <MenuIcon className="size-5" />
            </IconButton>
            <Logo size={24} />
            <IconButton label="Search" className="ml-auto" onClick={() => window.dispatchEvent(new CustomEvent("io:palette"))}>
              <Search className="size-5" />
            </IconButton>
          </div>
          <InstallPrompt />
          <SetupBanner />
          {me.mustEnroll2fa && (
            <div className="flex items-center gap-2 border-b border-warning/30 bg-warning-soft px-4 py-2 text-[13px] text-warning">
              <ShieldAlert className="size-4" /> Your organization requires two-factor authentication. Add a passkey or set up an authenticator app below to continue.
            </div>
          )}
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </main>
        <MobileComposeButton />
      </div>
      <PaletteHost />
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
