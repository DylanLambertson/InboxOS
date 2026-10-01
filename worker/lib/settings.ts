import { DEFAULT_BRAND, DEFAULT_POLICY, type Brand, type OrgPolicy } from "@shared/brand";
import { sanitizeTheme } from "@shared/theme";
import { DEFAULT_WORKSPACE, sanitizeWorkspace, type Workspace } from "@shared/workspace";
import { now, parseJson } from "./util";

export interface Settings {
  brand: Brand;
  policy: OrgPolicy;
  workspace: Workspace;
}

let cache: (Settings & { at: number }) | null = null;
const TTL = 15_000;

/**
 * A stored brand, completed with defaults. Brands saved before the theme tokens
 * existed kept accentColor/radius/fontFamily/googleFont at the top level; those
 * are folded into `theme` so older settings keep their look.
 */
export function normalizeBrand(stored: Partial<Brand> & Record<string, unknown>): Brand {
  const { accentColor, radius, fontFamily, googleFont, theme, ...rest } = stored;
  const legacy = { accent: accentColor, radius, fontFamily, googleFont };
  const definedLegacy = Object.fromEntries(Object.entries(legacy).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_BRAND, ...rest, theme: sanitizeTheme({ ...definedLegacy, ...(theme as object | undefined) }) } as Brand;
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('brand','policy','workspace')")
    .all<{ key: string; value: string }>();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const brand = normalizeBrand(parseJson<Partial<Brand> & Record<string, unknown>>(map.brand, {}));
  const policy = { ...DEFAULT_POLICY, ...parseJson<Partial<OrgPolicy>>(map.policy, {}) };
  const workspace = sanitizeWorkspace(parseJson<unknown>(map.workspace, {}), DEFAULT_WORKSPACE);
  cache = { at: Date.now(), brand, policy, workspace };
  return cache;
}

export const getBrand = async (db: D1Database) => (await loadSettings(db)).brand;
export const getPolicy = async (db: D1Database) => (await loadSettings(db)).policy;
export const getWorkspace = async (db: D1Database) => (await loadSettings(db)).workspace;

export type SettingKey = "brand" | "policy" | "workspace";

export async function saveSetting(db: D1Database, key: SettingKey, value: unknown, userId: string | null) {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4`,
    )
    .bind(key, JSON.stringify(value), now(), userId)
    .run();
  cache = null;
}

/** Drop the in-memory copy, e.g. after a test or a direct database write. */
export function invalidateSettings() {
  cache = null;
}
