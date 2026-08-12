/**
 * Minimal Resend REST client. All provider-specific code lives here so the
 * app can move to another provider (or a paid Resend plan with new features)
 * by editing a single file.
 */
const BASE = "https://api.resend.com";

export class ResendError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = "resend_error",
  ) {
    super(message);
  }
}

export interface ResendAttachment {
  filename: string;
  content: string; // base64
  content_type?: string;
  content_id?: string;
}

export interface ResendSendPayload {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: ResendAttachment[];
  tags?: { name: string; value: string }[];
}

export interface ReceivedEmail {
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string | null;
  html: string | null;
  html_format?: "data_uri" | "cid";
  text: string | null;
  headers: Record<string, string> | null;
  bcc: string[] | null;
  cc: string[] | null;
  reply_to: string[] | null;
  received_for?: string[] | null;
  message_id: string | null;
  attachments: {
    id: string;
    filename: string;
    content_type: string;
    content_disposition: string | null;
    content_id: string | null;
    size: number;
  }[];
}

export interface ReceivedAttachment {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
  download_url: string;
  expires_at: string;
}

async function call<T>(apiKey: string | undefined, path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  if (!apiKey) throw new ResendError("RESEND_API_KEY is not configured", 500, "not_configured");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "inboxos/1.0",
  };
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  // Resend rate-limits per second; retry 429/5xx a few times with backoff.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { ...init, headers });
    if (res.ok) return (await res.json()) as T;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 3) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 400 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 3000)));
      continue;
    }
    let body: { message?: string; name?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    throw new ResendError(body.message ?? `Resend request failed (${res.status})`, res.status, body.name);
  }
}

export const resend = {
  send: (key: string | undefined, payload: ResendSendPayload, idempotencyKey?: string) =>
    call<{ id: string }>(key, "/emails", { method: "POST", body: JSON.stringify(payload), idempotencyKey }),

  getReceived: (key: string | undefined, id: string) =>
    call<ReceivedEmail>(key, `/emails/receiving/${encodeURIComponent(id)}?html_format=cid`),

  listReceivedAttachments: (key: string | undefined, id: string) =>
    call<{ data: ReceivedAttachment[] }>(key, `/emails/receiving/${encodeURIComponent(id)}/attachments`),

  listDomains: (key: string | undefined) =>
    call<{ data: { id: string; name: string; status: string; region: string; created_at: string }[] }>(key, "/domains"),
};
