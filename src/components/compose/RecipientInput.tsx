import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Address } from "@shared/types";
import { displayName, fullAddress, isEmail, parseAddress } from "@/lib/format";
import { useContacts } from "@/lib/queries";
import { Avatar, cx } from "../ui/primitives";

/** Split pasted text like "a@x.com; Bob <b@y.com>, c@z.com" into addresses (plus leftovers). */
function splitMany(text: string): { addrs: Address[]; rest: string } {
  const parts = text.split(/[,;\n]+(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim()).filter(Boolean);
  const addrs: Address[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    const a = parseAddress(p);
    if (a) addrs.push(a);
    else bad.push(p);
  }
  return { addrs, rest: bad.join(", ") };
}

export function RecipientInput({
  label,
  value,
  onChange,
  autoFocus,
  trailing,
}: {
  label: string;
  value: Address[];
  onChange: (v: Address[]) => void;
  autoFocus?: boolean;
  trailing?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const q = text.trim();
  const { data: suggestions = [] } = useContacts(q, focused && q.length >= 1);
  const filtered = suggestions.filter((s) => !value.some((v) => v.email === s.email)).slice(0, 6);
  const showMenu = focused && q.length >= 1 && filtered.length > 0;

  useEffect(() => setActive(0), [q]);

  const add = (addrs: Address[]) => {
    const seen = new Set(value.map((v) => v.email));
    onChange([...value, ...addrs.filter((a) => !seen.has(a.email) && (seen.add(a.email), true))]);
  };

  const commit = (): boolean => {
    if (!q) return false;
    const { addrs, rest } = splitMany(q);
    if (addrs.length) add(addrs);
    setText(rest);
    return addrs.length > 0;
  };

  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  return (
    <div className="relative flex min-h-10 items-start gap-2 border-b border-line px-3 py-1.5" onClick={() => input.current?.focus()}>
      <span className="mt-1.5 w-9 shrink-0 text-[13px] text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((a, i) => {
          const valid = isEmail(a.email);
          return (
            <span
              key={a.email + i}
              title={fullAddress(a)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(i);
                setText(fullAddress(a));
                remove(i);
                input.current?.focus();
              }}
              className={cx(
                "inline-flex h-6 max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-0.5 text-[13px]",
                valid ? "bg-muted text-fg" : "bg-danger-soft text-danger",
              )}
            >
              <Avatar email={a.email} name={a.name} size={20} />
              <span className="truncate">{displayName(a)}</span>
              <button
                type="button"
                aria-label={`Remove ${a.email}`}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(i);
                }}
                className="rounded-full p-0.5 text-fg-faint hover:bg-line hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          autoFocus={autoFocus}
          value={text}
          aria-label={`${label} recipients`}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v) && parseAddress(v.replace(/[,;]\s*$/, ""))) {
              add([parseAddress(v.replace(/[,;]\s*$/, ""))!]);
              setText("");
            } else setText(v);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setTimeout(() => setFocused(false), 120);
            commit();
            setEditing(null);
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (/[,;\n]/.test(t)) {
              e.preventDefault();
              const { addrs, rest } = splitMany(t);
              add(addrs);
              setText(rest);
            }
          }}
          onKeyDown={(e) => {
            if (showMenu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length);
            } else if ((e.key === "Enter" || e.key === "Tab") && showMenu) {
              e.preventDefault();
              const s = filtered[active];
              add([{ email: s.email, name: s.name || undefined }]);
              setText("");
            } else if (e.key === "Enter" || (e.key === "Tab" && q) || e.key === ",") {
              if (commit() || e.key !== "Tab") e.preventDefault();
            } else if (e.key === "Backspace" && !text && value.length) {
              remove(value.length - 1);
            } else if (e.key === "Escape" && q) {
              e.stopPropagation();
              setText("");
            }
          }}
          className="h-7 min-w-[120px] flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-faint"
          placeholder={value.length ? "" : editing !== null ? "" : "Add people"}
        />
      </div>
      {trailing && <div className="mt-0.5 flex shrink-0 items-center gap-1">{trailing}</div>}

      {showMenu && (
        <div className="animate-in absolute top-full left-12 z-40 mt-1 w-[min(360px,calc(100%-3rem))] overflow-hidden rounded-ui border border-line bg-raised p-1 shadow-ui-lg">
          {filtered.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                add([{ email: s.email, name: s.name || undefined }]);
                setText("");
                input.current?.focus();
              }}
              className={cx("flex w-full items-center gap-2.5 rounded-ui-sm px-2 py-1.5 text-left", i === active && "bg-muted")}
            >
              <Avatar email={s.email} name={s.name} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{s.name || s.email}</span>
                <span className="block truncate text-xs text-fg-muted">
                  {s.email}
                  {s.company && ` · ${s.company}`}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
