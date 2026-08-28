import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { ComposeWindow } from "./ComposeWindow";
import type { ComposeRequest } from "./useDraft";

interface OpenComposer {
  key: string;
  req: ComposeRequest;
  minimized: boolean;
}

interface ComposeApi {
  open: (req: ComposeRequest) => void;
  /** Send a saved draft, honouring the user's undo-send delay. */
  send: (draftId: string, mailboxId: string, scheduledAt?: string | null) => void;
}

const Ctx = createContext<ComposeApi>({ open: () => undefined, send: () => undefined });
export const useCompose = () => useContext(Ctx);

const MAX_OPEN = 3;

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<OpenComposer[]>([]);
  const { data: me } = useMe();
  const qc = useQueryClient();
  const pendingSends = useRef(0);

  const open = useCallback((req: ComposeRequest) => {
    setWindows((ws) => {
      if (req.draftId) {
        const existing = ws.find((w) => w.req.draftId === req.draftId);
        if (existing) return ws.map((w) => (w === existing ? { ...w, minimized: false } : w));
      }
      const next = [...ws.map((w) => ({ ...w, minimized: true })), { key: Math.random().toString(36).slice(2), req, minimized: false }];
      return next.slice(-MAX_OPEN);
    });
  }, []);

  const close = (key: string) => setWindows((ws) => ws.filter((w) => w.key !== key));
  const toggle = (key: string) => setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, minimized: !w.minimized } : w)));

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["messages"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
    qc.invalidateQueries({ queryKey: ["thread"] });
  }, [qc]);

  const send = useCallback(
    (draftId: string, mailboxId: string, scheduledAt?: string | null) => {
      const doSend = async () => {
        const id = toast.loading(scheduledAt ? "Scheduling…" : "Sending…");
        try {
          await api.post(`drafts/${draftId}/send`, { scheduledAt: scheduledAt ?? null });
          toast.success(scheduledAt ? `Scheduled for ${new Date(scheduledAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "Message sent", { id });
        } catch (e) {
          toast.error(errorMessage(e), {
            id,
            duration: 10_000,
            action: { label: "Open draft", onClick: () => open({ mailboxId, draftId }) },
          });
        } finally {
          refresh();
        }
      };
      const delay = scheduledAt ? 0 : (me?.preferences.undoSendSeconds ?? 5);
      if (!delay) return void doSend();

      pendingSends.current++;
      let undone = false;
      const timer = setTimeout(() => {
        pendingSends.current--;
        if (!undone) doSend();
      }, delay * 1000);
      toast("Sending…", {
        duration: delay * 1000,
        description: `You have ${delay} seconds to undo.`,
        action: {
          label: "Undo",
          onClick: () => {
            undone = true;
            clearTimeout(timer);
            pendingSends.current--;
            open({ mailboxId, draftId });
            refresh();
          },
        },
      });
    },
    [me?.preferences.undoSendSeconds, open, refresh],
  );

  // Warn before closing the tab while a send is still in its undo window.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (pendingSends.current > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const value = useMemo(() => ({ open, send }), [open, send]);
  const fullscreenPref = me?.preferences.composeMode === "fullscreen";

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-0 bottom-0 z-[60] flex items-end gap-3 pr-4 max-sm:inset-0 max-sm:pr-0">
        {windows.map((w) => (
          <ComposeWindow
            key={w.key}
            req={w.req}
            minimized={w.minimized}
            defaultFullscreen={fullscreenPref}
            onToggleMinimize={() => toggle(w.key)}
            onClose={() => (close(w.key), refresh())}
            onSend={(draftId, mailboxId, at) => {
              close(w.key);
              send(draftId, mailboxId, at);
            }}
          />
        ))}
      </div>
    </Ctx.Provider>
  );
}
