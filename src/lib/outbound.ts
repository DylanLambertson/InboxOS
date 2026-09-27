import { useQuery } from "@tanstack/react-query";
import type { DlpFinding, SignatureMode } from "@shared/outbound";
import { api } from "./api";

export interface OrgSignature {
  mode: SignatureMode;
  /** Company signature rendered for the signed-in user (and mailbox, when given). */
  html: string;
}

/** The company signature policy as it applies to me sending from this mailbox. */
export const useOrgSignature = (mailboxId: string | undefined) =>
  useQuery({
    queryKey: ["org-signature", mailboxId ?? ""],
    queryFn: () => api.get<OrgSignature>(`outbound/signature${mailboxId ? `?mailboxId=${encodeURIComponent(mailboxId)}` : ""}`),
    staleTime: 60_000,
    retry: false,
  });

/** Pre-send DLP findings for a saved draft. The server re-checks at send time regardless. */
export const checkDraft = (draftId: string) => api.post<{ findings: DlpFinding[]; external: number }>("outbound/check", { draftId });
