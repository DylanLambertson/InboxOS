import { useEffect, useRef } from "react";
import { useBlocker } from "react-router";
import { useConfirm } from "@/components/ui/overlay";

/**
 * Ask before leaving a page with unsaved changes: in-app navigation shows a confirm
 * dialog, and closing or reloading the tab shows the browser's own prompt.
 */
export function useUnsavedChangesGuard(dirty: boolean, message = "Your changes on this page haven't been saved.") {
  const confirm = useConfirm();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const latest = useRef(blocker);
  latest.current = blocker;

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let live = true;
    void confirm({ title: "Leave without saving?", body: message, confirmLabel: "Discard changes", danger: true }).then((leave) => {
      if (!live) return;
      if (leave) latest.current.proceed?.();
      else latest.current.reset?.();
    });
    return () => {
      live = false;
    };
  }, [blocker.state, confirm, message]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);
}
