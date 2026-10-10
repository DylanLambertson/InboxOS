import { lazy, Suspense, useEffect, useState } from "react";

// The palette is a separate chunk. It's fetched when the browser is idle after the app
// loads, so the first ⌘K opens instantly and no keystrokes are lost while it loads.
const loadPalette = () => import("./CommandPalette");
const CommandPalette = lazy(loadPalette);

/** ⌘K / Ctrl+K anywhere opens the command palette; so does an `io:palette` event (e.g. a search button). */
export function PaletteHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    idle(() => void loadPalette());
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      // Another dialog is open (and it isn't the palette): leave it alone.
      if (!open && document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("io:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("io:palette", onOpen);
    };
  }, [open]);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette onClose={() => setOpen(false)} />
    </Suspense>
  );
}
