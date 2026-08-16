import { useEffect, useRef, type DependencyList } from "react";

type Handlers = Record<string, () => unknown>;

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};

/**
 * Gmail-style keyboard shortcuts. Keys: "c", "shift+i", "#", and two-key sequences like "g i".
 * Ignored while typing or when a modal/menu is open.
 */
export function useShortcuts(handlers: Handlers, deps: DependencyList) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector("[role=dialog],[role=menu]")) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const combo = e.shiftKey && /^[a-z]$/.test(key) ? `shift+${key}` : e.key === "#" || e.key === "!" || e.key === "?" ? e.key : key;

      if (pending.current && Date.now() - pending.current.at < 1200) {
        const seq = `${pending.current.key} ${combo}`;
        pending.current = null;
        if (ref.current[seq]) {
          e.preventDefault();
          ref.current[seq]();
          return;
        }
      }
      if (Object.keys(ref.current).some((k) => k.startsWith(`${combo} `))) {
        pending.current = { key: combo, at: Date.now() };
        return;
      }
      const fn = ref.current[combo];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export const SHORTCUT_HELP: [string, string][] = [
  ["C", "Compose"],
  ["/", "Search"],
  ["J / K", "Next / previous message"],
  ["O or Enter", "Open message"],
  ["U or Esc", "Back to list"],
  ["E", "Archive"],
  ["#", "Delete"],
  ["!", "Report spam"],
  ["S", "Star / unstar"],
  ["Shift + I", "Mark as read"],
  ["Shift + U", "Mark as unread"],
  ["R", "Reply"],
  ["A", "Reply all"],
  ["F", "Forward"],
  ["G then I", "Go to Inbox"],
  ["G then S", "Go to Starred"],
  ["G then T", "Go to Sent"],
  ["G then D", "Go to Drafts"],
  ["⌘/Ctrl + Enter", "Send (in compose)"],
  ["?", "Show shortcuts"],
];
