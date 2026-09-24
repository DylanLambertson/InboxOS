/** Shared-inbox collaboration: types and pure helpers used by both the Worker and the web client. */

export const CONVERSATION_STATUSES = ["open", "pending", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const NOTE_MAX = 5000;
/** How long a "replying" marker lives without a refresh from the open composer. */
export const PRESENCE_TTL_MS = 60_000;
export const PRESENCE_REFRESH_MS = 20_000;

export interface Person {
  id: string;
  name: string;
  email: string;
  color: string;
}

export interface MailboxMember extends Person {
  role: "owner" | "editor" | "viewer";
}

export interface ConversationNote {
  id: string;
  author: Person | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

export type ConversationEventType = "assigned" | "unassigned" | "status" | "note" | "note_deleted";

export interface ConversationEvent {
  id: string;
  type: ConversationEventType;
  actor: Person | null;
  target: Person | null;
  value: string | null;
  createdAt: string;
}

export interface ConversationInfo {
  mailboxId: string;
  threadId: string;
  status: ConversationStatus;
  assignee: Person | null;
  notes: ConversationNote[];
  events: ConversationEvent[];
  /** Other people with a reply open right now. */
  replying: Person[];
  canWrite: boolean;
}

export interface CollabCounts {
  /** Conversations assigned to me that aren't closed. */
  assigned: number;
  /** Notes mentioning me that I haven't opened yet. */
  mentions: number;
}

/** The @handle for a person: the part of their address before the @ (no spaces, so it survives in plain text). */
export function mentionHandle(email: string): string {
  return email.split("@")[0].toLowerCase();
}

const HANDLE_RE = /(?<![\w@.])@([a-z0-9][a-z0-9._+-]*)/gi;

/** Ids of the given members whose @handle appears in the text. Only members can ever be mentioned. */
export function findMentions(body: string, members: { id: string; email: string }[]): string[] {
  const handles = new Set<string>();
  for (const m of body.matchAll(HANDLE_RE)) handles.add(m[1].replace(/[._-]+$/, "").toLowerCase());
  return [...new Set(members.filter((m) => handles.has(mentionHandle(m.email))).map((m) => m.id))];
}

export type NoteSegment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string } | { kind: "mention"; text: string; handle: string };

const TOKEN_RE = /(https?:\/\/[^\s<>"']+)|((?<![\w@.])@[a-z0-9][a-z0-9._+-]*)/gi;

/**
 * Split a plain-text note into text, links and mentions for rendering. The client renders each
 * segment as a React text node, so nothing in a note is ever interpreted as HTML. Only http(s)
 * URLs become links; mentions are highlighted only when they name a known handle.
 */
export function noteSegments(body: string, handles: Set<string>): NoteSegment[] {
  const out: NoteSegment[] = [];
  let last = 0;
  const push = (s: NoteSegment) => {
    const prev = out[out.length - 1];
    if (s.kind === "text" && prev?.kind === "text") prev.text += s.text;
    else if (s.text) out.push(s);
  };
  for (const m of body.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    push({ kind: "text", text: body.slice(last, start) });
    if (m[1]) {
      // Trailing punctuation usually belongs to the sentence, not the URL.
      const url = m[1].replace(/[.,;:!?)\]]+$/, "");
      push({ kind: "link", text: url, href: url });
      push({ kind: "text", text: m[1].slice(url.length) });
    } else {
      const raw = m[2];
      const handle = raw.slice(1).replace(/[._-]+$/, "").toLowerCase();
      if (handles.has(handle)) {
        push({ kind: "mention", text: `@${handle}`, handle });
        push({ kind: "text", text: raw.slice(handle.length + 1) });
      } else push({ kind: "text", text: raw });
    }
    last = start + m[0].length;
  }
  push({ kind: "text", text: body.slice(last) });
  return out;
}

/** One-line description of an activity event, e.g. "Dylan assigned this to Priya". */
export function describeEvent(e: Pick<ConversationEvent, "type" | "actor" | "target" | "value">, meId?: string): string {
  const who = (p: Person | null, fallback: string) => (!p ? fallback : p.id === meId ? "you" : p.name || p.email.split("@")[0]);
  const actor = who(e.actor, "Someone");
  const Actor = actor === "you" ? "You" : actor;
  switch (e.type) {
    case "assigned":
      return e.actor && e.target && e.actor.id === e.target.id ? `${Actor} took this` : `${Actor} assigned this to ${who(e.target, "someone")}`;
    case "unassigned":
      return `${Actor} unassigned this`;
    case "status":
      if (!e.actor && e.value === "open") return "A new reply reopened this";
      return e.value === "closed" ? `${Actor} closed this` : e.value === "pending" ? `${Actor} marked this pending` : `${Actor} reopened this`;
    case "note":
      return `${Actor} added a note`;
    case "note_deleted":
      return `${Actor} deleted a note`;
    default:
      return `${Actor} updated this`;
  }
}
