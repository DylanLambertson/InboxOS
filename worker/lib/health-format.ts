/** Formatting helpers shared by the health check modules. */

export const DAY = 86_400_000;

/** "5 minutes ago", "3 days ago": coarse ages for check details. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const pct = (n: number) => `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
