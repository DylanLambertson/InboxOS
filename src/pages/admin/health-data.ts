import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HealthReport } from "@shared/health";
import { api } from "@/lib/api";

export const HEALTH_KEY = ["admin-health"] as const;

/** The health report (cached a minute on the server). Shared by the nav badge, dashboard and Health page. */
export const useHealth = (enabled = true) =>
  useQuery({
    queryKey: HEALTH_KEY,
    queryFn: () => api.get<HealthReport>("admin/health"),
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });

/** Run every check again, skipping the server cache. */
export function useRerunHealth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<HealthReport>("admin/health?refresh=1"),
    onSuccess: (report) => qc.setQueryData(HEALTH_KEY, report),
  });
}
