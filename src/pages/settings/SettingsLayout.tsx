import { FileText, Inbox, Shield, User, Users } from "lucide-react";
import type { FeatureKey } from "@shared/workspace";
import { SubNavLayout } from "@/components/layout/SubNav";
import { useFeatureFilter } from "@/lib/workspace";

const ITEMS: { to: string; label: string; icon: typeof User; feature?: FeatureKey }[] = [
  { to: "/settings/profile", label: "Profile & preferences", icon: User },
  { to: "/settings/mailboxes", label: "Mailboxes", icon: Inbox },
  { to: "/settings/security", label: "Security", icon: Shield },
  { to: "/settings/templates", label: "Templates", icon: FileText, feature: "templates" },
  { to: "/settings/contacts", label: "Contacts", icon: Users, feature: "contacts" },
];

export function SettingsLayout() {
  const visible = useFeatureFilter();
  return <SubNavLayout title="Settings" items={visible(ITEMS)} />;
}
