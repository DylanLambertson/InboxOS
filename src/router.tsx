import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "./components/layout/AppShell";
import { InvitePage, LoginPage, ResetPage } from "./pages/Auth";
import { VerifyEmailPage } from "./pages/VerifyEmail";
import { MailPage } from "./pages/Mail";

// Settings and Admin load on demand to keep the mail client's first load small.
const settings = () => import("./pages/settings");
const admin = () => import("./pages/admin");
const lazy = <M,>(load: () => Promise<M>, pick: (m: M) => React.ComponentType) => async () => ({ Component: pick(await load()) });

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/invite/:token", element: <InvitePage /> },
  { path: "/reset/:token", element: <ResetPage /> },
  { path: "/verify-email/:token", element: <VerifyEmailPage /> },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <MailPage /> },
      { path: "mail/:mailboxId/:view/:messageId?", element: <MailPage /> },
      {
        path: "settings",
        lazy: lazy(settings, (m) => m.SettingsLayout),
        children: [
          { index: true, element: <Navigate to="profile" replace /> },
          { path: "profile", lazy: lazy(settings, (m) => m.ProfileSettings) },
          { path: "mailboxes", lazy: lazy(settings, (m) => m.MailboxSettings) },
          { path: "security", lazy: lazy(settings, (m) => m.SecuritySettings) },
          { path: "templates", lazy: lazy(settings, (m) => m.TemplatesSettings) },
          { path: "contacts", lazy: lazy(settings, (m) => m.ContactsSettings) },
        ],
      },
      {
        path: "admin",
        lazy: lazy(admin, (m) => m.AdminLayout),
        children: [
          { index: true, lazy: lazy(admin, (m) => m.AdminOverview) },
          { path: "traffic", lazy: lazy(admin, (m) => m.AdminTraffic) },
          { path: "users", lazy: lazy(admin, (m) => m.AdminUsers) },
          { path: "mailboxes", lazy: lazy(admin, (m) => m.AdminMailboxes) },
          { path: "branding", lazy: lazy(admin, (m) => m.AdminBranding) },
          { path: "settings", lazy: lazy(admin, (m) => m.AdminPolicy) },
          { path: "api", lazy: lazy(admin, (m) => m.AdminApiKeys) },
          { path: "unsubscribes", lazy: lazy(admin, (m) => m.AdminUnsubscribes) },
          { path: "logs/:kind?", lazy: lazy(admin, (m) => m.AdminLogs) },
          { path: "setup", lazy: lazy(admin, (m) => m.AdminSetup) },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
