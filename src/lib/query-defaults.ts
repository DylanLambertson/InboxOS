import { keepPreviousData, type QueryClient } from "@tanstack/react-query";

/**
 * Caching for admin console data. Admin lists change rarely and every mutation
 * invalidates its own key, so revisiting a page shows cached data instantly instead of
 * refetching on every mount. Filtered, paged lists keep the previous page on screen
 * while the next one loads, so tables don't flash empty.
 */
const STALE: Record<string, number> = {
  "admin-users": 30_000,
  "admin-mailboxes": 30_000,
  "admin-settings": 60_000,
  "admin-retention": 60_000,
  "admin-holds": 60_000,
  "admin-api-keys": 60_000,
  "admin-provisioning": 60_000,
  "admin-outbound": 60_000,
  "admin-domains": 60_000,
  "admin-security-network": 60_000,
  "admin-security-stats": 30_000,
  "admin-event": Infinity,
  // Delivery and audit rows have different shapes, so the log never shows one in place of the other.
  "admin-logs": 15_000,
  workspace: 5 * 60_000,
};

const PAGED = ["admin-traffic", "admin-suppressions", "admin-sign-ins", "admin-sessions", "admin-search"];

export function applyQueryDefaults(qc: QueryClient) {
  for (const [key, staleTime] of Object.entries(STALE)) qc.setQueryDefaults([key], { staleTime });
  for (const key of PAGED) qc.setQueryDefaults([key], { staleTime: 15_000, placeholderData: keepPreviousData });
}
