import { mailDomains } from "@shared/brand";
import type { DomainDnsReport } from "@shared/dns";
import type { Env } from "../env";
import { checkDomainDns, expectedFromResend } from "./dns";
import { syncDomainAliases } from "./domains";
import { getResendApiKey } from "./provider-config";
import { explainKeyError, resend, ResendError, type ResendDomain } from "./resend";
import { loadSettings, saveSetting } from "./settings";
import { updateSetupState } from "./setup";
import { now } from "./util";

/**
 * Mail domains: the ones configured here (Brand.primaryDomain + additionalDomains)
 * joined with what the email provider knows about them.
 */

export const MAX_DOMAINS = 11;

export interface ProviderDomainSummary {
  id: string;
  status: string;
  region: string;
  receiving: boolean | null;
}

export interface DomainListItem {
  name: string;
  primary: boolean;
  provider: ProviderDomainSummary | null;
}

export interface DomainList {
  keyConfigured: boolean;
  /** Why the provider couldn't be asked (bad key, network…). */
  error: string | null;
  primaryDomain: string;
  domains: DomainListItem[];
  /** Domains in the provider account that aren't used here. */
  otherProviderDomains: { name: string; status: string }[];
}

export interface DomainDetail {
  name: string;
  primary: boolean;
  configured: boolean;
  provider: ResendDomain | null;
  providerError: string | null;
  dns: DomainDnsReport | null;
}

/** Remember the provider's view of domains so setup status can be derived without calling it. */
async function rememberDomains(db: D1Database, items: { name: string; id: string; status: string; region: string; receiving: boolean | null }[]) {
  if (!items.length) return;
  await updateSetupState(db, null, (s) => {
    for (const d of items) {
      s.domains[d.name] = { id: d.id, status: d.status, region: d.region, receiving: d.receiving ?? s.domains[d.name]?.receiving ?? false, checkedAt: now() };
    }
  });
}

async function forgetDomain(db: D1Database, name: string) {
  await updateSetupState(db, null, (s) => {
    delete s.domains[name];
  });
}

export async function listMailDomains(env: Env): Promise<DomainList> {
  const { brand } = await loadSettings(env.DB);
  const names = mailDomains(brand);
  const key = await getResendApiKey(env);
  let provider: { id: string; name: string; status: string; region: string; receiving: boolean | null }[] = [];
  let error: string | null = null;
  if (key) {
    try {
      const { data } = await resend.listDomains(key);
      provider = data.map((d) => ({
        id: d.id,
        name: d.name.toLowerCase(),
        status: d.status,
        region: d.region,
        receiving: d.capabilities ? d.capabilities.receiving === "enabled" : null,
      }));
      await rememberDomains(env.DB, provider.filter((p) => names.includes(p.name)));
    } catch (err) {
      error = explainKeyError(err).message;
    }
  }
  return {
    keyConfigured: !!key,
    error,
    primaryDomain: brand.primaryDomain,
    domains: names.map((name) => {
      const p = provider.find((d) => d.name === name);
      return { name, primary: name === brand.primaryDomain, provider: p ? { id: p.id, status: p.status, region: p.region, receiving: p.receiving } : null };
    }),
    otherProviderDomains: provider.filter((p) => !names.includes(p.name)).map((p) => ({ name: p.name, status: p.status })),
  };
}

/** Find a domain in the provider by name (ids aren't stored in the brand). */
export async function findProviderDomain(env: Env, name: string): Promise<ResendDomain | null> {
  const key = await getResendApiKey(env);
  const { data } = await resend.listDomains(key);
  const hit = data.find((d) => d.name.toLowerCase() === name);
  return hit ? resend.getDomain(key, hit.id) : null;
}

/** Everything about one domain: provider records and status, plus a live DNS check. */
export async function domainDetail(env: Env, name: string, opts: { dns?: boolean } = {}): Promise<DomainDetail> {
  const { brand } = await loadSettings(env.DB);
  const configured = mailDomains(brand).includes(name);
  let provider: ResendDomain | null = null;
  let providerError: string | null = null;
  try {
    provider = await findProviderDomain(env, name);
    if (provider) await rememberDomains(env.DB, [{ ...provider, receiving: provider.receiving }]);
  } catch (err) {
    providerError = err instanceof ResendError ? explainKeyError(err).message : "Couldn't reach the email provider.";
  }
  const dns = opts.dns !== false && provider ? await checkDomainDns(name, expectedFromResend(name, provider.records)) : null;
  return { name, primary: brand.primaryDomain === name, configured, provider, providerError, dns };
}

/** Save which domains are used here, then give every mailbox its address on each. */
export async function saveDomainConfig(env: Env, primaryDomain: string, additionalDomains: string[], userId: string) {
  const { brand } = await loadSettings(env.DB);
  const extra = [...new Set(additionalDomains.map((d) => d.toLowerCase()))].filter((d) => d !== primaryDomain);
  const next = { ...brand, primaryDomain, additionalDomains: extra };
  await saveSetting(env.DB, "brand", next, userId);
  await syncDomainAliases(env.DB);
  return next;
}

/** Create a domain in the provider (or adopt it when it already exists there). */
export async function connectProviderDomain(env: Env, name: string, opts: { region?: string; receiving: boolean }): Promise<ResendDomain> {
  const key = await getResendApiKey(env);
  const existing = await findProviderDomain(env, name);
  if (existing) return existing;
  const created = await resend.createDomain(key, { name, region: opts.region, receiving: opts.receiving });
  await rememberDomains(env.DB, [created]);
  return created;
}

export async function removeProviderDomain(env: Env, name: string): Promise<boolean> {
  const key = await getResendApiKey(env);
  const existing = await findProviderDomain(env, name);
  if (!existing) return false;
  await resend.deleteDomain(key, existing.id);
  await forgetDomain(env.DB, name);
  return true;
}
