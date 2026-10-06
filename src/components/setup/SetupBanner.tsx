import { Link, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { useSetupStatus } from "@/lib/setup";

/**
 * A quiet reminder for owners whose setup isn't finished. It never blocks the app:
 * one click continues the wizard, another hides the reminder.
 */
export function SetupBanner() {
  const { data: me } = useMe();
  const owner = me?.role === "owner";
  const { data } = useSetupStatus(owner);
  const qc = useQueryClient();
  const { pathname } = useLocation();
  if (!owner || !data || data.completed || data.dismissed || pathname.startsWith("/admin/setup")) return null;
  const dismiss = async () => {
    qc.setQueryData(["setup-status"], { ...data, dismissed: true });
    await api.put("admin/setup/progress", { dismiss: true }).catch(() => {});
  };
  return (
    <div className="flex items-center gap-3 border-b border-line bg-accent-softer px-4 py-2 text-[13px]">
      <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-fg">
        Setup is {data.progress}% done.<span className="text-fg-muted max-sm:hidden"> Finish connecting your domain and email provider to start sending and receiving.</span>
      </span>
      <Link to={`/setup/${data.nextStep}`} className="shrink-0 font-medium text-accent hover:underline">
        Continue setup
      </Link>
      <button type="button" onClick={dismiss} aria-label="Hide setup reminder" className="shrink-0 rounded-ui-sm p-1 text-fg-muted hover:bg-muted hover:text-fg">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
