import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DomainDnsReport } from "@shared/dns";
import type { PublicSetupStatus, SetupStepId, StepState } from "@shared/setup";
import type { Role } from "@shared/types";
import { api } from "./api";

/** Shapes returned by /api/admin/setup and /api/admin/domains (see worker/routes). */

export interface CredentialStatus {
  configured: boolean;
  source: "env" | "app" | null;
  masked: string | null;
  updatedAt: string | null;
  unreadable: boolean;
}

export interface ProviderStatusData {
  apiKey: CredentialStatus;
  webhookSecret: CredentialStatus;
}

export interface SetupTestState {
  send?: { to: string; from: string; resendId: string | null; at: string; error?: string };
  loopback?: { token: string; mailboxId: string; address: string; resendId: string | null; at: string; receivedAt?: string; error?: string };
}

export interface AdminSetup {
  completed: boolean;
  completedAt: string | null;
  dismissed: boolean;
  steps: Record<SetupStepId, StepState>;
  nextStep: SetupStepId;
  progress: number;
  setupKeySource: PublicSetupStatus["setupKeySource"];
  me: { id: string; name: string; email: string; role: Role };
  useCase: string;
  suggestedMailboxes: { local: string; name: string }[];
  primaryDomain: string;
  domains: { name: string; status: string | null }[];
  provider: ProviderStatusData;
  webhook: {
    endpoint: string;
    problem: string | null;
    registered: { id: string | null; endpoint: string; source: "auto" | "manual"; at: string } | null;
    secretFromEnv: boolean;
  };
  mailboxes: { id: string; address: string; name: string; type: string }[];
  users: { total: number; invited: number };
  test: SetupTestState;
}

export interface ProviderDnsRecord {
  record: string;
  name: string;
  type: string;
  ttl: string;
  status: string;
  value: string;
  priority?: number;
}

export interface ProviderDomain {
  id: string;
  name: string;
  status: string;
  region: string;
  createdAt: string;
  sending: boolean;
  receiving: boolean;
  records: ProviderDnsRecord[];
}

export interface DomainListItem {
  name: string;
  primary: boolean;
  provider: { id: string; status: string; region: string; receiving: boolean | null } | null;
}

export interface DomainList {
  keyConfigured: boolean;
  error: string | null;
  primaryDomain: string;
  domains: DomainListItem[];
  otherProviderDomains: { name: string; status: string }[];
}

export interface DomainDetail {
  name: string;
  primary: boolean;
  configured: boolean;
  provider: ProviderDomain | null;
  providerError: string | null;
  dns: DomainDnsReport | null;
}

export interface TestEvent {
  type: string;
  detail: string | null;
  created_at: string;
}

export interface SetupTests {
  send: (NonNullable<SetupTestState["send"]> & { events: TestEvent[] }) | null;
  loopback:
    | (NonNullable<SetupTestState["loopback"]> & {
        events: TestEvent[];
        arrived: { mailboxId: string; unrouted: boolean; at: string; messageId: string } | null;
      })
    | null;
}

/** Public: does an owner exist, and how far along is setup. */
export const useSetupStatus = (enabled = true) =>
  useQuery({ queryKey: ["setup-status"], queryFn: () => api.get<PublicSetupStatus>("setup/status"), staleTime: 30_000, enabled });

export const useAdminSetup = (enabled = true) => useQuery({ queryKey: ["admin-setup"], queryFn: () => api.get<AdminSetup>("admin/setup"), enabled });

export const useDomainList = () => useQuery({ queryKey: ["admin-domains-status"], queryFn: () => api.get<DomainList>("admin/domains/status") });

const VERIFIED = "verified";

/** One domain with a live DNS check. Re-checks every 20 seconds until it's verified. */
export const useDomainDetail = (name: string | null) =>
  useQuery({
    queryKey: ["admin-domain", name],
    queryFn: () => api.get<DomainDetail>(`admin/domains/${encodeURIComponent(name!)}`),
    enabled: !!name,
    refetchInterval: (q) => (q.state.data?.provider && q.state.data.provider.status !== VERIFIED ? 20_000 : false),
  });

/** Query keys to refresh after anything about setup changes. */
export const SETUP_KEYS = [["admin-setup"], ["setup-status"], ["admin-domains-status"], ["admin-overview"], ["admin-domain"]] as const;

/** Refresh every setup-related query (status, domains, overview). */
export function useRefreshSetup() {
  const qc = useQueryClient();
  return () => Promise.all(SETUP_KEYS.map((k) => qc.invalidateQueries({ queryKey: [...k] })));
}
