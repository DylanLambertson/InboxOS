import { lazy, Suspense, useEffect, useState } from "react";

// The palette itself is a separate chunk, fetched the first time it opens.
const CommandPalette = lazy(() => import("./CommandPalette"));

/** ⌘K / Ctrl+K anywhere opens the command palette; so does an `io:palette` event (e.g. a search button). */
export function PaletteHost() {
  const [open, setOpen] = useState(false);
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
