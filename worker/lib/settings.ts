import { DEFAULT_BRAND, DEFAULT_POLICY, type Brand, type OrgPolicy } from "@shared/brand";
import { now, parseJson } from "./util";

let cache: { at: number; brand: Brand; policy: OrgPolicy } | null = null;
const TTL = 15_000;

export async function loadSettings(db: D1Database): Promise<{ brand: Brand; policy: OrgPolicy }> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('brand','policy')")
    .all<{ key: string; value: string }>();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const brand = { ...DEFAULT_BRAND, ...parseJson<Partial<Brand>>(map.brand, {}) };
  const policy = { ...DEFAULT_POLICY, ...parseJson<Partial<OrgPolicy>>(map.policy, {}) };
  cache = { at: Date.now(), brand, policy };
  return cache;
}

export const getBrand = async (db: D1Database) => (await loadSettings(db)).brand;
export const getPolicy = async (db: D1Database) => (await loadSettings(db)).policy;

export async function saveSetting(db: D1Database, key: "brand" | "policy", value: unknown, userId: string) {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4`,
    )
    .bind(key, JSON.stringify(value), now(), userId)
    .run();
  cache = null;
}
