import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { Contact, Label, MailboxSummary, Me, MessageDetail, MessageListItem, Paged, Template, View } from "@shared/types";
import { api } from "./api";

export const POLL_MS = 30_000;

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("me"), staleTime: 60_000, retry: false });

export const useMailboxes = () =>
  useQuery({ queryKey: ["mailboxes"], queryFn: () => api.get<MailboxSummary[]>("mailboxes"), refetchInterval: POLL_MS });

export const useLabels = (mailboxId: string | undefined) =>
  useQuery({
    queryKey: ["labels", mailboxId],
    queryFn: () => api.get<Label[]>(`mailboxes/${mailboxId}/labels`),
    enabled: !!mailboxId,
    staleTime: 60_000,
  });

export interface ListParams {
  mailboxId: string;
  view: View;
  label?: string | null;
  q?: string;
  threads: boolean;
}

export const messagesKey = (p: ListParams) => ["messages", p.mailboxId, p.view, p.label ?? "", p.q ?? "", p.threads] as const;

export function useMessages(p: ListParams | null) {
  return useInfiniteQuery({
    queryKey: p ? messagesKey(p) : ["messages", "none"],
    enabled: !!p?.mailboxId,
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ mailbox: p!.mailboxId, view: p!.view, threads: p!.threads ? "1" : "0", limit: "50" });
      if (p!.label) qs.set("label", p!.label);
      if (p!.q) qs.set("q", p!.q);
      if (pageParam) qs.set("cursor", pageParam);
      return api.get<Paged<MessageListItem>>(`messages?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL_MS,
  });
}

export const useThread = (messageId: string | null) =>
  useQuery({
    queryKey: ["thread", messageId],
    queryFn: () => api.get<MessageDetail[]>(`messages/${messageId}/thread`),
    enabled: !!messageId,
  });

export type BulkAction = "read" | "unread" | "star" | "unstar" | "move" | "restore" | "labelAdd" | "labelRemove" | "delete";
export interface BulkInput {
  ids: string[];
  action: BulkAction;
  thread?: boolean;
  folder?: "inbox" | "archive" | "spam" | "trash";
  labelId?: string;
}

/** Bulk message action with optimistic updates for read/star so the UI feels instant. */
export function useMessageAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkInput) => api.post<{ ok: boolean; count: number }>("messages/bulk", input as unknown as Record<string, unknown>),
    onMutate: async (input) => {
      const patch: Partial<MessageListItem> | null =
        input.action === "read" ? { isRead: true }
        : input.action === "unread" ? { isRead: false }
        : input.action === "star" ? { isStarred: true }
        : input.action === "unstar" ? { isStarred: false }
        : null;
      const ids = new Set(input.ids);
      const removes = ["move", "restore", "delete"].includes(input.action);
      await qc.cancelQueries({ queryKey: ["messages"] });
      const snapshot = qc.getQueriesData<InfiniteData<Paged<MessageListItem>>>({ queryKey: ["messages"] });
      qc.setQueriesData<InfiniteData<Paged<MessageListItem>>>({ queryKey: ["messages"] }, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((pg) => ({
                ...pg,
                items: removes
                  ? pg.items.filter((m) => !ids.has(m.id))
                  : pg.items.map((m) => (ids.has(m.id) && patch ? { ...m, ...patch } : m)),
              })),
            }
          : old,
      );
      return { snapshot };
    },
    onError: (_e, _v, ctx) => ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      qc.invalidateQueries({ queryKey: ["thread"] });
    },
  });
}

export const useContacts = (q: string, enabled = true) =>
  useQuery({
    queryKey: ["contacts", q],
    queryFn: () => api.get<Contact[]>(`contacts?q=${encodeURIComponent(q)}&limit=8`),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: () => api.get<Template[]>("templates"), staleTime: 60_000 });

export function useInvalidateMail() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["messages"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
    qc.invalidateQueries({ queryKey: ["thread"] });
  };
}
