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
  if (!apiKey) throw new ResendError("The email provider isn't connected yet. Add a Resend API key in Admin → Setup.", 500, "not_configured");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "inboxos/1.0",
  };
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  // Resend rate-limits per second; retry 429/5xx a few times with backoff.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(BASE + path, { ...init, headers });
    } catch {
      throw new ResendError("Couldn't reach Resend. Check your connection and try again.", 502, "network_error");
    }
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
    call<{ data: { id: string; name: string; status: string; region: string; created_at: string; capabilities?: ResendCapabilities }[] }>(key, "/domains"),

  // ---- Domains ----------------------------------------------------------

  createDomain: async (key: string | undefined, opts: { name: string; region?: string; receiving?: boolean }) =>
    parseDomain(
      await call<unknown>(key, "/domains", {
        method: "POST",
        body: JSON.stringify({
          name: opts.name,
          ...(opts.region ? { region: opts.region } : {}),
          capabilities: { sending: "enabled", receiving: opts.receiving ? "enabled" : "disabled" },
        }),
      }),
    ),

  getDomain: async (key: string | undefined, id: string) => parseDomain(await call<unknown>(key, `/domains/${encodeURIComponent(id)}`)),

  /** Ask Resend to look for the DNS records now. Verification itself is asynchronous. */
  verifyDomain: (key: string | undefined, id: string) => call<{ id: string }>(key, `/domains/${encodeURIComponent(id)}/verify`, { method: "POST" }),

  /** Turn receiving on or off. Resend then adds (or drops) the receiving MX record. */
  setDomainReceiving: (key: string | undefined, id: string, receiving: boolean) =>
    call<{ id: string }>(key, `/domains/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ capabilities: { receiving: receiving ? "enabled" : "disabled" } }),
    }),

  deleteDomain: (key: string | undefined, id: string) => call<{ id: string; deleted?: boolean }>(key, `/domains/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ---- Webhooks ---------------------------------------------------------

  listWebhooks: async (key: string | undefined) => parseWebhookList(await call<unknown>(key, "/webhooks")),

  /** Register an endpoint. The signing secret is only ever returned here, so keep it. */
  createWebhook: async (key: string | undefined, endpoint: string, events: readonly string[]) => {
    const raw = await call<{ id?: unknown; signing_secret?: unknown }>(key, "/webhooks", { method: "POST", body: JSON.stringify({ endpoint, events }) });
    if (typeof raw?.id !== "string" || typeof raw.signing_secret !== "string") throw new ResendError("Resend didn't return a signing secret for the webhook.", 502, "bad_response");
    return { id: raw.id, signingSecret: raw.signing_secret };
  },

  deleteWebhook: (key: string | undefined, id: string) => call<{ id: string }>(key, `/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

// ---- Response parsing -----------------------------------------------------

export interface ResendCapabilities {
  sending?: string;
  receiving?: string;
}

export interface ResendDnsRecord {
  /** Resend's label: "DKIM", "SPF", "Receiving", "Tracking"… */
  record: string;
  name: string;
  type: string;
  ttl: string;
  status: string;
  value: string;
  priority?: number;
}

export interface ResendDomain {
  id: string;
  name: string;
  /** not_started, pending, verified, partially_verified, partially_failed, failed, temporary_failure */
  status: string;
  region: string;
  createdAt: string;
  sending: boolean;
  receiving: boolean;
  records: ResendDnsRecord[];
}

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback);

/** Normalize a domain object from the API, tolerating missing or extra fields. */
export function parseDomain(raw: unknown): ResendDomain {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.name !== "string") throw new ResendError("Unexpected response from Resend.", 502, "bad_response");
  const caps = (d.capabilities && typeof d.capabilities === "object" ? d.capabilities : {}) as ResendCapabilities;
  const records = Array.isArray(d.records) ? d.records : [];
  return {
    id: d.id,
    name: d.name.toLowerCase(),
    status: str(d.status, "not_started"),
    region: str(d.region, "us-east-1"),
    createdAt: str(d.created_at),
    sending: caps.sending !== "disabled",
    receiving: caps.receiving === "enabled",
    records: records
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as Record<string, unknown>).type === "string")
      .map((r) => ({
        record: str(r.record),
        name: str(r.name),
        type: str(r.type).toUpperCase(),
        ttl: str(r.ttl, "Auto"),
        status: str(r.status, "not_started"),
        value: str(r.value),
        ...(r.priority !== undefined && r.priority !== null && Number.isFinite(Number(r.priority)) ? { priority: Number(r.priority) } : {}),
      })),
  };
}

export interface ResendWebhook {
  id: string;
  endpoint: string;
  events: string[];
  status: string;
}

export function parseWebhookList(raw: unknown): ResendWebhook[] {
  const data = raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
  return data
    .filter((w): w is Record<string, unknown> => !!w && typeof w === "object" && typeof (w as Record<string, unknown>).id === "string")
    .map((w) => ({
      id: w.id as string,
      endpoint: str(w.endpoint),
      events: Array.isArray(w.events) ? w.events.filter((e): e is string => typeof e === "string") : [],
      status: str(w.status, "enabled"),
    }));
}

// ---- API key checks -------------------------------------------------------

export type KeyProblem = "invalid" | "sending_only" | "network" | "not_configured" | "unknown";
export type KeyCheck = { ok: true; domainCount: number } | { ok: false; problem: KeyProblem; message: string };

/** Turn a failed call into a reason and a message people can act on. */
export function explainKeyError(err: unknown): { problem: KeyProblem; message: string } {
  if (!(err instanceof ResendError)) return { problem: "unknown", message: "Something went wrong while checking the key." };
  if (err.code === "not_configured") return { problem: "not_configured", message: "No API key is set yet." };
  if (err.code === "network_error") return { problem: "network", message: err.message };
  if (err.code === "restricted_api_key" && err.status === 401) {
    return {
      problem: "sending_only",
      message: "This key can only send. The app also needs to read received mail and manage domains, so create a key with Full access.",
    };
  }
  if (err.status === 401 || err.status === 403 || err.code === "invalid_api_key" || err.code === "missing_api_key") {
    return { problem: "invalid", message: "Resend didn't accept this key. Check that you copied all of it and that it hasn't been deleted." };
  }
  if (err.status === 429) return { problem: "network", message: "Resend is rate limiting requests. Wait a moment and try again." };
  if (err.status >= 500) return { problem: "network", message: "Resend is having trouble right now. Try again in a minute." };
  return { problem: "unknown", message: err.message };
}

/** Check a key by listing domains, which needs a Full access key. */
export async function checkApiKey(key: string | undefined): Promise<KeyCheck> {
  try {
    const { data } = await resend.listDomains(key);
    return { ok: true, domainCount: Array.isArray(data) ? data.length : 0 };
  } catch (err) {
    return { ok: false, ...explainKeyError(err) };
  }
}

/** Resend API keys look like re_<base62>. */
export const looksLikeApiKey = (v: string) => /^re_[A-Za-z0-9_]{8,200}$/.test(v);
