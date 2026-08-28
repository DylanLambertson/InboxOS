import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, AttachmentInfo } from "@shared/types";
import { api, errorMessage, uploadWithProgress } from "@/lib/api";

export interface DraftAttachment extends AttachmentInfo {
  progress?: number;
  error?: string;
  tempId?: string;
}

export interface DraftState {
  id?: string;
  mailboxId: string;
  fromAddress: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  quoteHtml: string;
  keepQuote: boolean;
  attachments: DraftAttachment[];
  priority: "normal" | "high" | "low";
  readReceipt: boolean;
  mode: "new" | "reply" | "replyAll" | "forward";
  error?: string | null;
}

export interface ComposeRequest {
  mailboxId: string;
  draftId?: string;
  sourceId?: string;
  mode?: "reply" | "replyAll" | "forward";
  to?: Address[];
  subject?: string;
  html?: string;
}

interface DraftDto {
  id: string;
  mailboxId: string;
  fromAddress: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  attachments: AttachmentInfo[];
  priority: "normal" | "high" | "low";
  readReceipt: boolean;
  quoteHtml: string;
  mode: DraftState["mode"];
  error: string | null;
}

const fromDto = (d: DraftDto): DraftState => ({
  id: d.id,
  mailboxId: d.mailboxId,
  fromAddress: d.fromAddress,
  to: d.to,
  cc: d.cc,
  bcc: d.bcc,
  subject: d.subject,
  html: d.html,
  quoteHtml: d.quoteHtml,
  keepQuote: true,
  attachments: d.attachments,
  priority: d.priority,
  readReceipt: d.readReceipt,
  mode: d.mode,
  error: d.error,
});

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export function useDraft(req: ComposeRequest, signatureHtml: string) {
  const [state, setState] = useState<DraftState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const stateRef = useRef<DraftState | null>(null);
  stateRef.current = state;
  const saving = useRef<Promise<void> | null>(null);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const withSignature = useCallback((body: string) => (signatureHtml ? `${body}<p></p><p>-- </p>${signatureHtml}` : body), [signatureHtml]);

  // Load / create the draft once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (req.draftId) {
          const d = await api.get<DraftDto>(`drafts/${req.draftId}`);
          if (!cancelled) setState(fromDto(d));
        } else if (req.sourceId && req.mode) {
          const d = await api.post<DraftDto>("drafts/from", { sourceId: req.sourceId, mode: req.mode });
          if (!cancelled) setState({ ...fromDto(d), html: withSignature("<p></p>") });
        } else if (!cancelled) {
          setState({
            mailboxId: req.mailboxId,
            fromAddress: "",
            to: req.to ?? [],
            cc: [],
            bcc: [],
            subject: req.subject ?? "",
            html: req.html ?? withSignature("<p></p>"),
            quoteHtml: "",
            keepQuote: true,
            attachments: [],
            priority: "normal",
            readReceipt: false,
            mode: "new",
          });
        }
      } catch (e) {
        if (!cancelled) setLoadError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (saving.current) {
      pending.current = true;
      return saving.current;
    }
    const s = stateRef.current;
    if (!s) return;
    setStatus("saving");
    saving.current = (async () => {
      try {
        const d = await api.post<DraftDto>("drafts", {
          id: s.id,
          mailboxId: s.mailboxId,
          fromAddress: s.fromAddress || undefined,
          to: s.to,
          cc: s.cc,
          bcc: s.bcc,
          subject: s.subject,
          html: s.html,
          attachmentIds: s.attachments.filter((a) => !a.tempId && !a.error).map((a) => a.id),
          priority: s.priority,
          requestReadReceipt: s.readReceipt,
          keepQuote: s.keepQuote,
        });
        setState((cur) => (cur ? { ...cur, id: d.id, fromAddress: d.fromAddress, mailboxId: d.mailboxId, error: null } : cur));
        stateRef.current = stateRef.current ? { ...stateRef.current, id: d.id, mailboxId: d.mailboxId } : null;
        setStatus("saved");
        setSavedAt(Date.now());
      } catch (e) {
        setStatus("error");
        throw e;
      } finally {
        saving.current = null;
      }
    })();
    await saving.current;
    if (pending.current) {
      pending.current = false;
      await save();
    }
  }, []);

  const update = useCallback(
    (patch: Partial<DraftState>) => {
      setState((cur) => (cur ? { ...cur, ...patch } : cur));
      setStatus("dirty");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => save().catch(() => undefined), 1500);
    },
    [save],
  );

  /** Save now; resolves with the persisted draft id and mailbox. */
  const flush = useCallback(async (): Promise<{ id: string; mailboxId: string }> => {
    clearTimeout(timer.current);
    await save();
    const s = stateRef.current;
    if (!s?.id) throw new Error("Draft wasn't saved");
    return { id: s.id, mailboxId: s.mailboxId };
  }, [save]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const upload = useCallback(
    async (file: File, inline = false): Promise<DraftAttachment | null> => {
      const s = stateRef.current;
      if (!s) return null;
      const tempId = `tmp-${Math.random().toString(36).slice(2)}`;
      const placeholder: DraftAttachment = { id: tempId, tempId, filename: file.name, contentType: file.type, size: file.size, contentId: null, inline, progress: 0 };
      if (!inline) setState((cur) => (cur ? { ...cur, attachments: [...cur.attachments, placeholder] } : cur));
      const form = new FormData();
      form.append("file", file);
      form.append("mailboxId", s.mailboxId);
      if (inline) form.append("inline", "1");
      try {
        const info = await uploadWithProgress<AttachmentInfo>("attachments", form, (p) =>
          setState((cur) => (cur ? { ...cur, attachments: cur.attachments.map((a) => (a.tempId === tempId ? { ...a, progress: p } : a)) } : cur)),
        );
        setState((cur) =>
          cur
            ? { ...cur, attachments: inline ? [...cur.attachments, info] : cur.attachments.map((a) => (a.tempId === tempId ? info : a)) }
            : cur,
        );
        stateRef.current = stateRef.current
          ? { ...stateRef.current, attachments: [...stateRef.current.attachments.filter((a) => a.tempId !== tempId), info] }
          : null;
        update({});
        return info;
      } catch (e) {
        setState((cur) => (cur ? { ...cur, attachments: cur.attachments.map((a) => (a.tempId === tempId ? { ...a, error: errorMessage(e) } : a)) } : cur));
        return null;
      }
    },
    [update],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setState((cur) => (cur ? { ...cur, attachments: cur.attachments.filter((a) => a.id !== id) } : cur));
      update({});
    },
    [update],
  );

  return { state, loadError, status, savedAt, update, flush, upload, removeAttachment, uploading: !!state?.attachments.some((a) => a.tempId && !a.error) };
}
