import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button, cx, IconButton, Input } from "./primitives";

// ---- Modal ----------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
        const list = [...f].filter((el) => !el.hasAttribute("disabled"));
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("[autofocus],input,textarea,select,button:not([data-close])")?.focus());
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      <div className="animate-fade absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className="animate-in relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-ui-lg border border-line bg-raised shadow-ui-lg sm:rounded-ui-lg"
        style={{ maxWidth: width }}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
            <div>
              {title && <h2 className="text-base font-semibold text-fg">{title}</h2>}
              {description && <p className="mt-1 text-[13px] text-fg-muted">{description}</p>}
            </div>
            <IconButton label="Close" size="sm" onClick={onClose} data-close>
              <X className="size-4" />
            </IconButton>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line bg-subtle px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---- Confirm dialogs ------------------------------------------------------

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Require the user to type this text to confirm. */
  typeToConfirm?: string;
}
type ConfirmFn = (o: ConfirmOpts) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState("");
  const confirm = useCallback<ConfirmFn>((o) => new Promise((resolve) => (setTyped(""), setState({ ...o, resolve }))), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const blocked = !!state?.typeToConfirm && typed.trim().toLowerCase() !== state.typeToConfirm.toLowerCase();
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        title={state?.title}
        width={420}
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={state?.danger ? "danger" : "primary"} disabled={blocked} onClick={() => close(true)}>
              {state?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      >
        {state?.body && <div className="text-[13px] text-fg-muted">{state.body}</div>}
        {state?.typeToConfirm && (
          <div className="mt-4 space-y-1.5">
            <p className="text-[13px] text-fg-muted">
              Type <span className="font-mono font-medium text-fg">{state.typeToConfirm}</span> to confirm.
            </p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </div>
        )}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

// ---- Dropdown menu --------------------------------------------------------

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  checked?: boolean;
  separator?: boolean;
  hint?: ReactNode;
}

export function Menu({
  trigger,
  items,
  align = "start",
  width = 220,
  header,
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu" }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  width?: number;
  header?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(-1);
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selectable = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const menuH = menu.current?.offsetHeight ?? 200;
    const top = r.bottom + 4 + menuH > window.innerHeight ? Math.max(8, r.top - menuH - 4) : r.bottom + 4;
    let left = align === "end" ? r.right - width : r.left;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    setPos({ top, left });
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.stopPropagation(), setOpen(false));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = selectable.indexOf(active);
        const next = e.key === "ArrowDown" ? selectable[(idx + 1) % selectable.length] : selectable[(idx - 1 + selectable.length) % selectable.length];
        setActive(next ?? -1);
      }
      if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        items[active]?.onSelect?.();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, active, items, selectable]);

  return (
    <>
      <span ref={anchor} className="inline-flex">
        {trigger({ onClick: () => (setActive(-1), setOpen((o) => !o)), "aria-expanded": open, "aria-haspopup": "menu" })}
      </span>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className="animate-in fixed z-[120] max-h-[70vh] overflow-y-auto rounded-ui border border-line bg-raised p-1 shadow-ui-lg"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
          >
            {header}
            {items.map((it, i) =>
              it.separator ? (
                <div key={i} className="my-1 h-px bg-line" />
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  disabled={it.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    it.onSelect?.();
                    setOpen(false);
                  }}
                  className={cx(
                    "flex w-full items-center gap-2.5 rounded-ui-sm px-2.5 py-1.5 text-left text-[13px] disabled:opacity-40",
                    it.danger ? "text-danger" : "text-fg",
                    active === i && "bg-muted",
                  )}
                >
                  {it.icon && <span className="flex size-4 shrink-0 items-center justify-center text-fg-muted [&>svg]:size-4">{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">
                    {it.label}
                    {it.hint && <span className="block truncate text-[11px] text-fg-muted">{it.hint}</span>}
                  </span>
                  {it.checked && <span className="text-accent">✓</span>}
                  {it.shortcut && <span className="text-[11px] text-fg-faint">{it.shortcut}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---- Tabs -----------------------------------------------------------------

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="inline-flex rounded-ui border border-line bg-subtle p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            "rounded-ui-sm px-3 py-1 text-[13px] font-medium transition-colors",
            value === t.value ? "bg-raised text-fg shadow-ui-sm" : "text-fg-muted hover:text-fg",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
