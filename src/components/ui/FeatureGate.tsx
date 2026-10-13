import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router";
import { ToggleLeft } from "lucide-react";
import { FEATURES, type FeatureKey } from "@shared/workspace";
import { useCanManage } from "@/lib/queries";
import { useFeature } from "@/lib/workspace";
import { EmptyState } from "./primitives";

/** Shown in place of a page whose feature is switched off. */
export function FeatureOff({ feature }: { feature: FeatureKey }) {
  const canManage = useCanManage();
  return (
    <EmptyState
      icon={<ToggleLeft className="size-5" />}
      title={`${FEATURES[feature].label} is turned off`}
      body={
        canManage
          ? "Switch it back on in Admin → Features. Nothing was deleted while it was off."
          : "An admin turned this off for your workspace. Nothing was deleted; ask them if you need it."
      }
      action={
        canManage ? (
          <Link to="/admin/features" className="text-[13px] font-medium text-accent-ink hover:underline">
            Open Features
          </Link>
        ) : undefined
      }
    />
  );
}

/** Render children only while a feature is on; otherwise a friendly notice (or `fallback`). */
export function FeatureGate({ feature, children, fallback }: { feature: FeatureKey; children: ReactNode; fallback?: ReactNode }) {
  const on = useFeature(feature);
  if (on) return <>{children}</>;
  return <>{fallback === undefined ? <FeatureOff feature={feature} /> : fallback}</>;
}

/** Wrap a routed page so it shows the notice while its feature is off. */
export function withFeature<P extends object>(feature: FeatureKey, Page: ComponentType<P>): ComponentType<P> {
  function Gated(props: P) {
    return (
      <FeatureGate feature={feature}>
        <Page {...props} />
      </FeatureGate>
    );
  }
  Gated.displayName = `withFeature(${feature})`;
  return Gated;
}
