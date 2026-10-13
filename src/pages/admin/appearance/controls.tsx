import { useEffect, useId, useState, type ReactNode } from "react";
import { isHexColor } from "@shared/theme";
import { cx } from "@/components/ui/primitives";

/** Native color picker plus a hex field that only commits valid #rrggbb values. */
export function ColorField({ value, onChange, label, invalid }: { value: string; onChange: (hex: string) => void; label: string; invalid?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (raw: string) => {
    const v = raw.trim().toLowerCase();
    const hex = /^[0-9a-f]{6}$/.test(v) ? `#${v}` : /^#[0-9a-f]{3}$/.test(v) ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
    if (isHexColor(hex)) onChange(hex);
    else setText(value);
  };
  return (
    <span
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-ui border bg-surface pr-2 pl-1 transition-colors focus-within:border-accent-ink focus-within:ring-3 focus-within:ring-accent-soft",
        invalid ? "border-warning" : "border-line hover:border-line-strong",
      )}
    >
      <input
        type="color"
        aria-label={`${label} color picker`}
        value={value}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        className="size-6 shrink-0 cursor-pointer rounded-ui-sm border-0 bg-transparent p-0 [&::-webkit-color-swatch]:rounded-[4px] [&::-webkit-color-swatch]:border-line [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <input
        aria-label={`${label} hex value`}
        value={text}
        spellCheck={false}
        maxLength={7}
        onChange={(e) => {
          setText(e.target.value);
          const v = e.target.value.trim().toLowerCase();
          if (isHexColor(v)) onChange(v);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit((e.target as HTMLInputElement).value)}
        className="w-[4.6rem] bg-transparent font-mono text-xs text-fg outline-none"
      />
    </span>
  );
}

/** A row of mutually exclusive options (radio group). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; hint?: string }[];
  label: string;
  className?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cx("inline-flex flex-wrap rounded-ui border border-line bg-subtle p-0.5", className)}>
      {options.map((o) => (
        <label
          key={o.value}
          title={o.hint}
          className={cx(
            "flex cursor-pointer items-center gap-1.5 rounded-ui-sm px-3 py-1 text-[13px] font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-ink",
            value === o.value ? "bg-raised text-fg shadow-ui-sm" : "text-fg-muted hover:text-fg",
          )}
        >
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Label + description on the left, control on the right; stacks on phones. */
export function SettingRow({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
