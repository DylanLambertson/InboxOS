import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PRESENCE_REFRESH_MS, type CollabCounts, type ConversationInfo, type ConversationStatus, type MailboxMember } from "@shared/collab";
import { api } from "./api";
import { POLL_MS } from "./queries";

/** Shared-inbox collaboration queries: assignee, status, notes, activity and who's replying. */

const convPath = (mailboxId: string, threadId: string) => `conversations/t/${encodeURIComponent(mailboxId)}/${encodeURIComponent(threadId)}`;

export function useConversation(mailboxId: string | undefined, threadId: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["conversation", mailboxId, threadId],
    queryFn: () => api.get<ConversationInfo>(convPath(mailboxId!, threadId!)),
    enabled: !!mailboxId && !!threadId,
    // Frequent enough that "Priya is replying…" shows up while it matters.
    refetchInterval: 15_000,
  });
  // Opening a conversation marks its mentions seen on the server; refresh the sidebar badge.
  const loaded = query.data?.threadId;
  useEffect(() => {
    if (loaded) void qc.invalidateQueries({ queryKey: ["collab-counts"] });
  }, [loaded, qc]);
  return query;
}

export const useMembers = (mailboxId: string | undefined) =>
  useQuery({
    queryKey: ["members", mailboxId],
    queryFn: () => api.get<MailboxMember[]>(`conversations/members/${encodeURIComponent(mailboxId!)}`),
    enabled: !!mailboxId && mailboxId !== "all",
    staleTime: 5 * 60_000,
  });

export const useCollabCounts = () =>
  useQuery({ queryKey: ["collab-counts"], queryFn: () => api.get<CollabCounts>("conversations/counts"), refetchInterval: POLL_MS });

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["conversation"] });
    qc.invalidateQueries({ queryKey: ["messages"] });
    qc.invalidateQueries({ queryKey: ["collab-counts"] });
  };
}

export function useConversationActions(mailboxId: string, threadId: string) {
  const refresh = useRefresh();
  const base = convPath(mailboxId, threadId);
  return {
    assign: useMutation({ mutationFn: (assigneeId: string | null) => api.post(`${base}/assign`, { assigneeId }), onSettled: refresh }),
    setStatus: useMutation({ mutationFn: (status: ConversationStatus) => api.post(`${base}/status`, { status }), onSettled: refresh }),
    addNote: useMutation({ mutationFn: (body: string) => api.post<{ id: string }>(`${base}/notes`, { body }), onSettled: refresh }),
    editNote: useMutation({ mutationFn: (v: { id: string; body: string }) => api.patch(`conversations/notes/${encodeURIComponent(v.id)}`, { body: v.body }), onSettled: refresh }),
    deleteNote: useMutation({ mutationFn: (id: string) => api.del(`conversations/notes/${encodeURIComponent(id)}`), onSettled: refresh }),
  };
}

/** Assign or change status for the conversations of many selected messages. */
export function useBulkConversation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { ids: string[]; assigneeId?: string | null; status?: ConversationStatus }) => api.post<{ count: number }>("conversations/bulk", v),
    onSettled: refresh,
  });
}

/** While a reply to `messageId` is open, tell teammates "<me> is replying…". */
export function useReplyingPresence(messageId: string | undefined) {
  useEffect(() => {
    if (!messageId) return;
    let stopped = false;
    let inflight: Promise<unknown> = Promise.resolve();
    const ping = () => {
      if (!stopped) inflight = api.post("conversations/presence", { messageId }).catch(() => undefined);
    };
    ping();
    const timer = window.setInterval(ping, PRESENCE_REFRESH_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      // Clear after any in-flight ping lands, or that ping would resurrect the marker for a minute.
      void inflight.then(() => api.del("conversations/presence", { messageId })).catch(() => undefined);
    };
  }, [messageId]);
}
