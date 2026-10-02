import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "./components/layout/AppShell";
import { MailPage } from "./pages/Mail";
import { pages as p, routeLazy as page } from "./lib/route-chunks";

// Only the mail client is in the first load. Sign-in, Settings and every Admin page
// are separate chunks (see lib/route-chunks.ts), prefetched on hover from the navigation.
export const router = createBrowserRouter([
  { path: "/login", lazy: page(p.login, "LoginPage") },
  { path: "/invite/:token", lazy: page(p.login, "InvitePage") },
  { path: "/reset/:token", lazy: page(p.login, "ResetPage") },
  { path: "/verify-email/:token", lazy: page(p.verifyEmail, "VerifyEmailPage") },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <MailPage /> },
      { path: "mail/:mailboxId/:view/:messageId?", element: <MailPage /> },
      {
        path: "settings",
        lazy: page(p.settingsLayout, "SettingsLayout"),
        children: [
          { index: true, element: <Navigate to="profile" replace /> },
          { path: "profile", lazy: page(p.settingsProfile, "ProfileSettings") },
          { path: "mailboxes", lazy: page(p.settingsMailboxes, "MailboxSettings") },
          { path: "security", lazy: page(p.settingsSecurity, "SecuritySettings") },
          { path: "templates", lazy: page(p.settingsTemplates, "TemplatesSettings") },
          { path: "contacts", lazy: page(p.settingsContacts, "ContactsSettings") },
        ],
      },
      {
        path: "admin",
        lazy: page(p.adminLayout, "AdminLayout"),
        children: [
          { index: true, lazy: page(p.adminOverview, "AdminOverview") },
          { path: "health", lazy: page(p.adminHealth, "AdminHealth") },
          { path: "traffic", lazy: page(p.adminTraffic, "AdminTraffic") },
          { path: "users", lazy: page(p.adminUsers, "AdminUsers") },
          { path: "mailboxes", lazy: page(p.adminMailboxes, "AdminMailboxes") },
          { path: "branding", lazy: page(p.adminBranding, "AdminBranding") },
          { path: "settings", lazy: page(p.adminPolicy, "AdminPolicy") },
          { path: "api", lazy: page(p.adminApiKeys, "AdminApiKeys") },
          { path: "provisioning", lazy: page(p.adminProvisioning, "AdminProvisioning") },
          { path: "unsubscribes", lazy: page(p.adminUnsubscribes, "AdminUnsubscribes") },
          { path: "security/:tab?", lazy: page(p.adminSecurity, "AdminSecurity") },
          { path: "compliance", lazy: page(p.adminCompliance, "AdminCompliance") },
          { path: "outbound", lazy: page(p.adminOutbound, "AdminOutboundPolicy") },
          { path: "logs/:kind?", lazy: page(p.adminLogs, "AdminLogs") },
          { path: "setup", lazy: page(p.adminSetup, "AdminSetup") },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
