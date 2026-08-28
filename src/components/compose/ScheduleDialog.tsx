import { useMemo, useState } from "react";
import { CalendarClock } from "lucide-react";
import { Button, Field, Input } from "../ui/primitives";
import { Modal } from "../ui/overlay";

function at(daysFromNow: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function nextMonday(hour: number): Date {
  const d = new Date();
  const add = ((8 - d.getDay()) % 7) || 7;
  return at(add, hour);
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ScheduleDialog({ open, onClose, onSchedule }: { open: boolean; onClose: () => void; onSchedule: (iso: string) => void }) {
  const presets = useMemo(
    () =>
      [
        { label: "Tomorrow morning", date: at(1, 8) },
        { label: "Tomorrow afternoon", date: at(1, 13) },
        { label: "Monday morning", date: nextMonday(8) },
      ].filter((p) => p.date.getTime() > Date.now()),
    [open],
  );
  const [custom, setCustom] = useState(() => toLocalInput(at(1, 9)));
  const customDate = new Date(custom);
  const valid = !Number.isNaN(customDate.getTime()) && customDate.getTime() > Date.now() + 60_000;
  const fmt = (d: Date) => d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <Modal open={open} onClose={onClose} title="Schedule send" description={`Times are in your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`} width={420}>
      <div className="space-y-1">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => onSchedule(p.date.toISOString())}
            className="flex w-full items-center justify-between rounded-ui px-3 py-2.5 text-left text-[13px] hover:bg-muted"
          >
            <span className="font-medium">{p.label}</span>
            <span className="text-fg-muted">{fmt(p.date)}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <Field label="Pick date & time" error={custom && !valid ? "Choose a time in the future." : null}>
          <div className="flex gap-2">
            <Input type="datetime-local" value={custom} min={toLocalInput(new Date())} onChange={(e) => setCustom(e.target.value)} />
            <Button variant="primary" icon={<CalendarClock className="size-4" />} disabled={!valid} onClick={() => onSchedule(customDate.toISOString())}>
              Schedule
            </Button>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
