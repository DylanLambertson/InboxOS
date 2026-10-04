import { useEffect, useState } from "react";
import { Check, Clock, Copy, Globe, Mail, MapPin, Phone } from "lucide-react";
import { toast } from "sonner";
import { isValidTimeZone, localTime, timeZoneCity, type Teammate } from "@shared/profile";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, Card, cx, IconButton } from "@/components/ui/primitives";

/** The current time, refreshed every minute (for "local time" labels). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Hours a time zone is ahead of (positive) or behind the viewer, e.g. 6 or -2.5. */
export function hoursFromViewer(timezone: string, at: Date): number {
  if (!isValidTimeZone(timezone)) return 0;
  const there = new Date(at.toLocaleString("en-US", { timeZone: timezone }));
  const here = new Date(at.toLocaleString("en-US"));
  return Math.round(((there.getTime() - here.getTime()) / 3_600_000) * 2) / 2;
}

function offsetLabel(h: number): string {
  if (h === 0) return "same time as you";
  const abs = Math.abs(h);
  return `${abs}h ${h > 0 ? "ahead" : "behind"}`;
}

/** Website as a short label: "example.com/me". */
const shortUrl = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

/** How a teammate appears in the People directory (and in your own profile preview). */
export function TeammateCard({ t, now, isMe, className }: { t: Teammate; now: Date; isMe?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const time = t.timezone ? localTime(t.timezone, now) : "";
  const hour = t.timezone && isValidTimeZone(t.timezone) ? Number(now.toLocaleString("en-US", { timeZone: t.timezone, hour: "numeric", hour12: false })) % 24 : null;
  const offHours = hour !== null && (hour < 8 || hour >= 19);
  const role = [t.jobTitle, t.department].filter(Boolean).join(" · ");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t.email);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Select the address instead.");
    }
  };

  return (
    <Card className={cx("flex flex-col gap-3 p-4", className)}>
      <div className="flex items-start gap-3">
        <Avatar name={t.name} email={t.email} color={t.color} src={t.avatarUrl} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <h3 className="truncate text-sm font-semibold text-fg">{t.name || t.email.split("@")[0]}</h3>
            {t.pronouns && <span className="text-xs text-fg-muted">({t.pronouns})</span>}
            {isMe && <Badge tone="accent">You</Badge>}
          </div>
          {role && <p className="truncate text-[13px] text-fg-muted">{role}</p>}
        </div>
      </div>

      {t.bio && <p className="line-clamp-3 text-[13px] whitespace-pre-line text-fg">{t.bio}</p>}

      <ul className="mt-auto space-y-1.5 text-[13px] text-fg-muted">
        <li className="flex min-w-0 items-center gap-2">
          <Mail className="size-3.5 shrink-0" />
          <a href={`mailto:${t.email}`} className="min-w-0 truncate hover:text-fg hover:underline">
            {t.email}
          </a>
          <IconButton size="sm" label={copied ? "Copied" : "Copy email"} onClick={copy} className="-my-1 ml-auto">
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </IconButton>
        </li>
        {t.phone && (
          <li className="flex items-center gap-2">
            <Phone className="size-3.5 shrink-0" />
            <a href={`tel:${t.phone.replace(/[^0-9+]/g, "")}`} className="truncate hover:text-fg hover:underline">
              {t.phone}
            </a>
          </li>
        )}
        {(t.location || t.timezone) && (
          <li className="flex items-center gap-2">
            <MapPin className="size-3.5 shrink-0" />
            <span className="truncate">{t.location || timeZoneCity(t.timezone)}</span>
          </li>
        )}
        {time && (
          <li className="flex items-center gap-2" title={t.timezone}>
            <Clock className={cx("size-3.5 shrink-0", offHours && "text-warning")} />
            <span className="truncate">
              <span className="text-fg tabular-nums">{time}</span> local{!isMe && <> · {offsetLabel(hoursFromViewer(t.timezone, now))}</>}
              {offHours && !isMe && <span className="text-warning"> · likely off hours</span>}
            </span>
          </li>
        )}
        {t.website && (
          <li className="flex items-center gap-2">
            <Globe className="size-3.5 shrink-0" />
            <a href={t.website} target="_blank" rel="noopener noreferrer nofollow" className="truncate hover:text-fg hover:underline">
              {shortUrl(t.website)}
            </a>
          </li>
        )}
      </ul>
    </Card>
  );
}
