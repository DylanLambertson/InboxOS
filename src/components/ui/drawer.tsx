import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./primitives";

/** A panel that slides in from the right, for "everything about one thing" views. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  actions,
  children,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      // Let an open dialog or menu above the drawer handle Escape first.
      if (e.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => ref.current?.focus());
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex justify-end">
      <div className="animate-fade absolute inset-0 bg-black/30" onClick={onClose} />
      <aside
        ref={ref}
        tabIndex={-1}
        role="complementary"
        aria-label={typeof title === "string" ? title : undefined}
        className="animate-in relative flex h-full w-full flex-col border-l border-line bg-raised shadow-ui-lg outline-none"
        style={{ maxWidth: width }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            {title && <h2 className="truncate text-base font-semibold text-fg">{title}</h2>}
            {description && <div className="mt-0.5 text-[13px] text-fg-muted">{description}</div>}
          </div>
          {actions}
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
