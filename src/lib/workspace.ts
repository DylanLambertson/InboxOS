import { useQuery } from "@tanstack/react-query";
import { DEFAULT_WORKSPACE, type FeatureKey, type Workspace } from "@shared/workspace";
import { api } from "./api";

/** What this install is used for and which features are switched on (Admin → Features). */
export const useWorkspace = () =>
  useQuery({ queryKey: ["workspace"], queryFn: () => api.get<Workspace>("workspace"), staleTime: 5 * 60_000, placeholderData: DEFAULT_WORKSPACE });

/** Whether a feature is on. Defaults to on while loading, so nothing flickers away. */
export function useFeature(key: FeatureKey): boolean {
  const { data } = useWorkspace();
  return (data ?? DEFAULT_WORKSPACE).features[key];
}

/** Keep only the items whose feature is on (items without a feature always stay). */
export function useFeatureFilter() {
  const features = (useWorkspace().data ?? DEFAULT_WORKSPACE).features;
  return <T extends { feature?: FeatureKey }>(items: T[]) => items.filter((i) => !i.feature || features[i.feature]);
}
