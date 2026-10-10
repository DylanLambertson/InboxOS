import type { Address } from "@shared/types";
import { PROVIDER_EVENT_MAP, type MailboxRef } from "@shared/webhooks";
import type { DeliveryEventData as ProviderEvent, RoutedMessage } from "./inbound";
import type { MessageRow } from "./messages";
import type { QueuedEvent } from "./webhooks";
import { parseJson } from "./util";

/** Builders that turn what just happened into webhook events (see shared/webhooks.ts). */

async function mailboxRefs(db: D1Database, ids: string[]): Promise<Map<string, MailboxRef>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { results } = await db
    .prepare(`SELECT id, address FROM mailboxes WHERE id IN (${unique.map(() => "?").join(",")})`)
    .bind(...unique)
    .all<{ id: string; address: string }>();
  const found = new Map(results.map((r) => [r.id, r.address]));
  return new Map(unique.map((id) => [id, { id, address: found.get(id) ?? null }]));
}

/** `message.received` for routed mail that didn't land in spam. */
export async function receivedEvents(db: D1Database, routed: RoutedMessage[]): Promise<QueuedEvent[]> {
  const wanted = routed.filter((r) => r.folder !== "spam");
  if (!wanted.length) return [];
  const refs = await mailboxRefs(db, wanted.map((r) => r.mailboxId));
  return wanted.map((r) => ({
    type: "message.received" as const,
    data: { ...r.message, mailbox: refs.get(r.mailboxId)!, folder: r.folder },
  }));
}

/** A provider delivery update (delivered, bounced, …) as a webhook event, if it maps to one. */
export async function deliveryEvent(
  db: D1Database,
  providerType: string,
  data: ProviderEvent,
  message: { messageId: string; mailboxId: string } | null,
): Promise<QueuedEvent | null> {
  const type = PROVIDER_EVENT_MAP[providerType];
  if (!type) return null;
  const mailbox = message ? (await mailboxRefs(db, [message.mailboxId])).get(message.mailboxId)! : null;
  const detail = data.bounce
    ? [data.bounce.type, data.bounce.subType, data.bounce.message].filter(Boolean).join(" · ") || null
    : data.failed?.reason ?? null;
  return {
    type,
    data: {
      messageId: message?.messageId ?? null,
      providerId: data.email_id,
      mailbox,
      recipients: (data.to ?? []).slice(0, 50),
      detail,
      ...(data.bounce ? { bounce: { type: data.bounce.type, subType: data.bounce.subType, message: data.bounce.message } } : {}),
      ...(data.click?.link ? { click: { link: data.click.link } } : {}),
    },
  } as QueuedEvent;
}

/** `message.sent` once the provider accepted a message. */
export async function sentEvent(db: D1Database, m: MessageRow, mailboxAddress: string, fromName: string): Promise<QueuedEvent> {
  const refs = await mailboxRefs(db, [m.mailbox_id]);
  const ref = refs.get(m.mailbox_id) ?? { id: m.mailbox_id, address: mailboxAddress };
  const from: Address = { email: m.from_addr || mailboxAddress, ...(fromName ? { name: fromName } : {}) };
  return {
    type: "message.sent",
    data: {
      id: m.id,
      threadId: m.thread_id,
      mailbox: ref,
      from,
      to: parseJson<Address[]>(m.to_json, []),
      cc: parseJson<Address[]>(m.cc_json, []),
      subject: m.subject,
      snippet: m.snippet,
      hasAttachments: !!m.has_attachments,
      date: m.sent_at ?? m.date,
      providerId: m.resend_id ?? "",
    },
  };
}
