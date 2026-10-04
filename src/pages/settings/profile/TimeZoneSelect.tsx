import { useMemo } from "react";
import { timeZoneCity } from "@shared/profile";
import { Select } from "@/components/ui/primitives";

/** The browser's own time zone, e.g. "Europe/Berlin" (or "" if it can't tell). */
export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
};

function allZones(): string[] {
  try {
    const list = Intl.supportedValuesOf("timeZone");
    return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    return ["UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Africa/Lagos", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland"];
  }
}

/** "GMT+02:00" style offset of a zone right now, plus minutes for sorting. */
function offsetOf(tz: string, at: Date): { label: string; minutes: number } {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
    const minutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
    return { label: name === "GMT" ? "GMT+00:00" : name, minutes };
  } catch {
    return { label: "", minutes: 0 };
  }
}

/** All IANA time zones, ordered by current UTC offset, labelled with the city. */
export function TimeZoneSelect({ value, onChange, id }: { value: string; onChange: (tz: string) => void; id?: string }) {
  const options = useMemo(() => {
    const now = new Date();
    const zones = allZones();
    if (value && !zones.includes(value)) zones.push(value);
    return zones
      .map((tz) => ({ tz, ...offsetOf(tz, now) }))
      .sort((a, b) => a.minutes - b.minutes || a.tz.localeCompare(b.tz))
      .map(({ tz, label }) => {
        const region = tz.includes("/") ? tz.split("/")[0].replace(/_/g, " ") : "";
        return { tz, text: `(${label.replace("GMT", "UTC")}) ${timeZoneCity(tz)}${region ? ` · ${region}` : ""}` };
      });
  }, [value]);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not set</option>
      {options.map((o) => (
        <option key={o.tz} value={o.tz}>
          {o.text}
        </option>
      ))}
    </Select>
  );
}
