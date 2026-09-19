/** Types shared by the Worker API and the web client. */

/** Hidden system mailbox that holds mail sent to addresses with no mailbox (see Admin → All traffic). */
export const UNROUTED_MAILBOX_ID = "system-unrouted";

/** manager = read-only access to the admin console. */
export type Role = "owner" | "admin" | "manager" | "member";
export type UserStatus = "active" | "invited" | "disabled";
export type MailboxRole = "owner" | "editor" | "viewer";
export type MailboxType = "personal" | "shared";

export const FOLDERS = ["inbox", "sent", "drafts", "scheduled", "snoozed", "archive", "spam", "trash"] as const;
export type Folder = (typeof FOLDERS)[number];
/** Virtual views that aren't stored folders. */
export type View = Folder | "starred" | "all" | "unread";

export type MessageStatus =
  | "received"
  | "draft"
  | "scheduled"
  | "queued"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "failed"
  | "canceled"
  | "suppressed";

export interface Address {
  email: string;
  name?: string;
}

export interface Preferences {
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  /** Seconds to wait before sending so the user can undo. 0 disables. */
  undoSendSeconds: number;
  /** Load remote images in received mail automatically. */
  loadRemoteImages: boolean;
  /** Mark as read when opened. */
  markReadOnOpen: boolean;
  /** Open compose as a docked window or full screen. */
  composeMode: "docked" | "fullscreen";
  /** Group messages into conversations. */
  conversationView: boolean;
  /** Show a desktop notification when new mail arrives while the app is in the background. */
  desktopNotifications: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  density: "comfortable",
  undoSendSeconds: 5,
  loadRemoteImages: false,
  markReadOnOpen: true,
  composeMode: "docked",
  conversationView: true,
  desktopNotifications: false,
};

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
  totpEnabled: boolean;
  hasPassword: boolean;
  googleLinked: boolean;
  signatureHtml: string;
  preferences: Preferences;
  mustEnroll2fa: boolean;
}

export interface MailboxSummary {
  id: string;
  address: string;
  /** Label shown in the sidebar and lists (internal only). */
  name: string;
  /** Sender name recipients see in the From line. */
  displayName: string;
  type: MailboxType;
  color: string;
  role: MailboxRole;
  signatureHtml: string;
  unread: Record<string, number>;
  aliases: string[];
}

export interface MessageListItem {
  id: string;
  threadId: string;
  mailboxId: string;
  folder: Folder;
  direction: "inbound" | "outbound";
  status: MessageStatus;
  from: Address;
  to: Address[];
  subject: string;
  snippet: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  labels: string[];
  date: string;
  threadCount: number;
  scheduledAt: string | null;
  /** When a snoozed message comes back to the inbox. */
  snoozedUntil: string | null;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface MessageDetail extends MessageListItem {
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  html: string | null;
  text: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  headers: Record<string, string>;
  attachments: AttachmentInfo[];
  resendId: string | null;
  error: string | null;
  openCount: number;
  clickCount: number;
  events: EmailEvent[];
  sentBy: { id: string; name: string } | null;
}

export interface EmailEvent {
  id: string;
  type: string;
  createdAt: string;
  detail: string | null;
}

export interface Label {
  id: string;
  mailboxId: string;
  name: string;
  color: string;
}

export interface DraftInput {
  id?: string;
  mailboxId: string;
  fromAddress?: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo?: Address[];
  subject: string;
  html: string;
  text?: string;
  inReplyToMessageId?: string | null;
  mode?: "new" | "reply" | "replyAll" | "forward";
  attachmentIds: string[];
  priority?: "normal" | "high" | "low";
  scheduledAt?: string | null;
  requestReadReceipt?: boolean;
}

export interface Contact {
  id: string;
  email: string;
  name: string;
  company: string;
  notes: string;
  timesContacted: number;
  lastContactedAt: string | null;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  html: string;
  scope: "org" | "personal";
  ownerId: string | null;
  updatedAt: string;
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
