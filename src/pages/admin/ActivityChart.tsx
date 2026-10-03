import { useMemo, useState } from "react";

export interface Point {
  day: string;
  sent: number;
  system: number;
  received: number;
  bounced: number;
}

/** One point per UTC day for the last `days` days, from the overview's per-day event counts. */
export function dailyPoints(rows: { day: string; type: string; n: number }[], days = 14): Point[] {
  const out: Point[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const of = (t: string) => rows.reduce((s, r) => (r.day === key && r.type === t ? s + r.n : s), 0);
    out.push({ day: key, sent: of("accepted"), system: of("system"), received: of("received") + of("received.unrouted"), bounced: of("bounced") });
  }
  return out;
}

const SERIES = [
  { key: "sent", label: "Sent by team", color: "var(--series-1)" },
  { key: "system", label: "System emails", color: "var(--series-3)" },
  { key: "received", label: "Received", color: "var(--series-2)" },
] as const;

/** 14-day grouped bar chart: team mail, system emails (invites, resets, alerts) and received mail. */
export function ActivityChart({ rows }: { rows: { day: string; type: string; n: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const data = useMemo(() => dailyPoints(rows), [rows]);

  const max = Math.max(4, ...data.flatMap((d) => [d.sent, d.system, d.received]));
  const niceMax = Math.ceil(max / 4) * 4;
  const W = 640;
  const H = 180;
  const pad = { l: 28, r: 8, t: 8, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / data.length;
  const barW = Math.max(3, Math.min(11, (slot - 10) / SERIES.length));
  const y = (v: number) => pad.t + ih - (v / niceMax) * ih;
  const label = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  const total = (k: (typeof SERIES)[number]["key"]) => data.reduce((s, d) => s + d[k], 0);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-fg-muted">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label} <span className="font-medium text-fg tabular-nums">{total(s.key)}</span>
          </span>
        ))}
        <button onClick={() => setAsTable((t) => !t)} className="ml-auto text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline">
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-56 overflow-y-auto rounded-ui border border-line">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-subtle text-left text-xs text-fg-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">Day</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="px-3 py-1.5 text-right font-medium">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((d) => (
                <tr key={d.day}>
                  <td className="px-3 py-1.5">{label(d.day)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="px-3 py-1.5 text-right tabular-nums">{d[s.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Messages sent and received per day, last 14 days">
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={pad.l} x2={W - pad.r} y1={y(niceMax * f)} y2={y(niceMax * f)} stroke="var(--border)" strokeDasharray={f ? "2 3" : undefined} />
                <text x={pad.l - 6} y={y(niceMax * f) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                  {Math.round(niceMax * f)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = pad.l + slot * i + slot / 2;
              return (
                <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill={hover === i ? "var(--bg-muted)" : "transparent"} />
                  {SERIES.map((s, si) => {
                    const v = d[s.key];
                    const h = Math.max(v ? 2 : 0, pad.t + ih - y(v));
                    const x = cx - (SERIES.length * barW + (SERIES.length - 1) * 2) / 2 + si * (barW + 2);
                    return h > 0 ? <path key={s.key} d={roundedTop(x, pad.t + ih - h, barW, h, Math.min(4, barW / 2))} fill={s.color} /> : null;
                  })}
                  {(i % 2 === 1 || data.length <= 7) && (
                    <text x={cx} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                      {label(d.day)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-ui border border-line bg-raised px-3 py-2 text-xs shadow-ui-md"
              style={{ left: `${((pad.l + slot * hover + slot / 2) / W) * 100}%` }}
            >
              <p className="mb-1 font-medium">{label(data[hover].day)}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center gap-1.5 whitespace-nowrap text-fg-muted">
                  <span className="size-2 rounded-sm" style={{ background: s.color }} />
                  {s.label} <span className="ml-auto pl-3 font-medium text-fg tabular-nums">{data[hover][s.key]}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}
