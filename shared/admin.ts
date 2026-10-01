/** Response shapes for the admin console's dashboard and quick search. */

export interface Kpi {
  current: number;
  /** Same-length period just before. */
  previous: number;
}

export interface OverviewData {
  usage: { today: number; month: number; systemToday: number; systemMonth: number; dailyLimit: number; monthlyLimit: number };
  counts: { users: number; invited: number; mailboxes: number; messages: number; bytes: number; scheduled: number; unrouted: number };
  /** Rolling windows of `kpiDays` days compared with the window before. */
  kpiDays: number;
  kpis: { sent: Kpi; received: Kpi; bounces: Kpi; complaints: Kpi; activeUsers: Kpi };
  series: { day: string; type: string; n: number }[];
  recentProblems: { id: string; type: string; detail: string | null; recipient: string | null; created_at: string; subject: string | null; message_id: string | null }[];
  provider: { apiKey: boolean; webhookSecret: boolean; google: boolean; webhookUrl: string };
  generatedAt: string;
}

export interface AdminSearchResults {
  users: { id: string; name: string; email: string; role: string; status: string }[];
  mailboxes: { id: string; address: string; name: string; type: string }[];
  aliases: { address: string; mailboxId: string; mailbox: string }[];
  domains: { name: string; primary: boolean }[];
}

/** Change between periods as a fraction (0.25 = +25%), or null when there's nothing to compare with. */
export function kpiDelta(k: Kpi): number | null {
  if (!k.previous) return k.current ? null : 0;
  return (k.current - k.previous) / k.previous;
}
