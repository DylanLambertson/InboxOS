import { useEffect, useState } from "react";
import { colorFor, initials } from "@/lib/format";

export interface AvatarProps {
  /** Shown as initials when there's no photo (falls back to the email). */
  name?: string | null;
  email: string;
  /** Background for initials; defaults to a stable color for the email. */
  color?: string | null;
  /** Profile photo URL (e.g. Me.avatarUrl or Person.avatarUrl). */
  src?: string | null;
  /** Pixel size of the circle. */
  size?: number;
  className?: string;
  /** Accessible name. Without it the avatar is decorative (the name is usually next to it). */
  label?: string;
}

/**
 * A person's photo, or their initials on their color. A photo that fails to load (deleted,
 * offline) falls back to initials instead of a broken image.
 */
export function Avatar({ name, email, color, src, size = 32, className, label }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const box = { width: size, height: size };
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={label ?? ""}
        aria-hidden={label ? undefined : true}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className={["shrink-0 rounded-full bg-muted object-cover", className].filter(Boolean).join(" ")}
        style={box}
      />
    );
  }
  return (
    <span
      {...a11y}
      className={["inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none", className].filter(Boolean).join(" ")}
      style={{ ...box, background: color || colorFor(email), fontSize: Math.max(10, Math.round(size * 0.38)) }}
    >
      {initials(name || email)}
    </span>
  );
}
