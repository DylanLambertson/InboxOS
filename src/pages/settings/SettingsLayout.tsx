import { FileText, Inbox, Shield, User, Users } from "lucide-react";
import { SubNavLayout } from "@/components/layout/SubNav";

export function SettingsLayout() {
  return (
    <SubNavLayout
      title="Settings"
      items={[
        { to: "/settings/profile", label: "Profile & preferences", icon: User },
        { to: "/settings/mailboxes", label: "Mailboxes", icon: Inbox },
        { to: "/settings/security", label: "Security", icon: Shield },
        { to: "/settings/templates", label: "Templates", icon: FileText },
        { to: "/settings/contacts", label: "Contacts", icon: Users },
      ]}
    />
  );
}
