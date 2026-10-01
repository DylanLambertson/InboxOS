/**
 * HEALTH CENTER: the shape of Admin → Health, shared by the API and the console.
 */

export type HealthStatus = "ok" | "warn" | "fail" | "info";

export const HEALTH_AREAS = ["provider", "domains", "jobs", "sending", "security", "storage", "routing"] as const;
export type HealthArea = (typeof HEALTH_AREAS)[number];

export const HEALTH_AREA_LABELS: Record<HealthArea, string> = {
  provider: "Email provider",
  domains: "Domains",
  jobs: "Background jobs",
  sending: "Sending",
  security: "Security",
  storage: "Storage & database",
  routing: "Mail routing",
};

export interface HealthFix {
  label: string;
  /** In-app path, e.g. /admin/domains. */
  to?: string;
  /** External link (docs, provider dashboard). */
  href?: string;
}

export interface HealthCheck {
  id: string;
  area: HealthArea;
  status: HealthStatus;
  title: string;
  detail: string;
  fix?: HealthFix;
}

export interface HealthReport {
  checks: HealthCheck[];
  /** 0–100; informational checks don't count. */
  score: number;
  counts: Record<HealthStatus, number>;
  generatedAt: string;
}

/** Problems worth a badge: failures and warnings. */
export const healthIssueCount = (r: Pick<HealthReport, "counts"> | null | undefined) => (r ? r.counts.fail + r.counts.warn : 0);
