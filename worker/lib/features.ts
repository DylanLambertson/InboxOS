import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { FEATURES, type FeatureKey } from "@shared/workspace";
import type { AppEnv } from "../env";
import { getWorkspace } from "./settings";

/**
 * FEATURE SWITCHES (Admin → Features)
 *
 * Turning a feature off hides it in the app; these guards make sure the API agrees, so a
 * switched-off feature can't be used by an old tab, a script or an API key either. Data is
 * never deleted: switching the feature back on brings everything back as it was.
 */

/** "Snooze is turned off for this workspace." */
export function featureOffMessage(key: FeatureKey): string {
  return `${FEATURES[key].label} is turned off for this workspace.`;
}

/** Whether a feature is on (reads the cached workspace settings). */
export async function featureEnabled(db: D1Database, key: FeatureKey): Promise<boolean> {
  return (await getWorkspace(db)).features[key] !== false;
}

/** Throw a 403 with a clear message when a feature is off. For checks inside a handler. */
export async function assertFeature(c: Context<AppEnv>, key: FeatureKey): Promise<void> {
  if (!(await featureEnabled(c.env.DB, key))) throw new HTTPException(403, { message: featureOffMessage(key) });
}

/**
 * Middleware: refuse every request under a route while its feature is off.
 * `methods` limits the guard to some methods, e.g. only writes, so people can still
 * read (or remove) what they made while the feature was on.
 */
export function requireFeature(key: FeatureKey, opts: { methods?: string[] } = {}): MiddlewareHandler<AppEnv> {
  const methods = opts.methods?.map((m) => m.toUpperCase());
  return async (c, next) => {
    if (!methods || methods.includes(c.req.method)) await assertFeature(c, key);
    await next();
  };
}

/** Only POST, PUT and PATCH: creating and changing things, not reading or deleting them. */
export const WRITES = ["POST", "PUT", "PATCH"];

/** Guard for outgoing webhooks (Admin → Webhooks, mounted at /api/admin/webhooks). */
export const requireWebhooks = requireFeature("webhooks");
