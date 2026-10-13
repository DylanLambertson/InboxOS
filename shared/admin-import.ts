/**
 * CSV import for the admin console: the columns each import understands, how
 * headers are recognised, and row checks that need nothing but the row itself.
 * The browser runs these for an instant preview; the server runs them again
 * (never trusting the client) and adds the checks that need the database.
 */
import { isValidTimeZone, PROFILE_LIMITS } from "./profile";
import type { MailboxRole, Role } from "./types";

export const IMPORT_MAX_ROWS = 1000;
/**
 * Rows per commit request; the wizard sends bigger files in chunks and shows progress.
 * Kept small so each request stays under the D1 free plan's 50 queries per invocation.
 */
export const IMPORT_CHUNK = 8;

export type ImportKind = "users" | "mailboxes" | "aliases";

export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  /** Other header spellings recognised automatically. */
  aliases: string[];
  hint: string;
}

export const IMPORT_FIELDS: Record<ImportKind, ImportField[]> = {
  users: [
    { key: "email", label: "Email", required: true, aliases: ["emailaddress", "mail", "login", "username", "user"], hint: "Their sign-in address." },
    { key: "name", label: "Name", aliases: ["fullname", "displayname", "person"], hint: "Optional." },
    { key: "role", label: "Role", aliases: ["access", "permission", "type"], hint: "member, manager, admin or owner. Defaults to member." },
    { key: "mailbox", label: "Personal mailbox", aliases: ["personalmailbox", "mailboxaddress", "workemail", "workaddress", "address"], hint: "Optional. Creates a personal mailbox they own." },
    { key: "jobTitle", label: "Job title", aliases: ["title", "position", "jobtitle"], hint: "Optional, used in signatures." },
    { key: "phone", label: "Phone", aliases: ["telephone", "phonenumber", "mobile", "tel"], hint: "Optional, used in signatures." },
    { key: "department", label: "Department", aliases: ["dept", "team", "division"], hint: "Optional, shown in the team directory." },
    { key: "timezone", label: "Time zone", aliases: ["tz", "timezone", "zone"], hint: "Optional, e.g. Europe/Berlin." },
    { key: "sendInvite", label: "Send invite", aliases: ["invite", "sendinvite", "email invite", "notify"], hint: "yes or no. Defaults to yes." },
  ],
  mailboxes: [
    { key: "address", label: "Address", required: true, aliases: ["email", "emailaddress", "mailbox"], hint: "The mailbox's email address." },
    { key: "name", label: "Mailbox name", aliases: ["label", "sidebarname"], hint: "Optional sidebar label." },
    { key: "displayName", label: "Sender name", aliases: ["displayname", "fromname", "sender"], hint: "Optional. What recipients see." },
    { key: "type", label: "Type", aliases: ["kind", "mailboxtype"], hint: "shared or personal. Defaults to shared." },
    { key: "members", label: "Members", aliases: ["access", "users", "people"], hint: "email:access pairs separated by ; (access is owner, editor or viewer)." },
  ],
  aliases: [
    { key: "address", label: "Alias", required: true, aliases: ["alias", "aliasaddress", "from", "email"], hint: "The extra address." },
    { key: "mailbox", label: "Delivers to", required: true, aliases: ["mailboxaddress", "to", "target", "destination"], hint: "The address of an existing mailbox." },
  ],
};

/** Example rows for the downloadable templates. */
export const IMPORT_TEMPLATES: Record<ImportKind, string[][]> = {
  users: [
    ["email", "name", "role", "mailbox", "job_title", "phone", "department", "timezone", "send_invite"],
    ["jane@example.com", "Jane Doe", "member", "jane@yourcompany.com", "Account Manager", "+1 555 0100", "Sales", "America/New_York", "yes"],
    ["sam@example.com", "Sam Lee", "admin", "", "", "", "", "", "no"],
  ],
  mailboxes: [
    ["address", "name", "display_name", "type", "members"],
    ["support@yourcompany.com", "Support", "YourCompany Support", "shared", "jane@example.com:editor;sam@example.com:viewer"],
  ],
  aliases: [
    ["address", "mailbox"],
    ["help@yourcompany.com", "support@yourcompany.com"],
  ],
};

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const isImportEmail = (s: string) => s.length <= 254 && EMAIL_RE.test(s);

export function parseYesNo(raw: string | undefined, dflt: boolean): boolean | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return dflt;
  if (["yes", "y", "true", "1", "on", "x"].includes(v)) return true;
  if (["no", "n", "false", "0", "off"].includes(v)) return false;
  return null;
}

export function parseRole(raw: string | undefined): Role | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "member";
  return (["owner", "admin", "manager", "member"] as const).find((r) => r === v || `${r}s` === v) ?? (v === "user" ? "member" : null);
}

export function parseAccess(raw: string | undefined): MailboxRole | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!v) return "editor";
  if (["owner", "editor", "viewer"].includes(v)) return v as MailboxRole;
  if (["cansend", "send", "write", "edit", "member"].includes(v)) return "editor";
  if (["read", "readonly", "view", "reader"].includes(v)) return "viewer";
  return null;
}

export interface MemberSpec {
  email: string;
  access: MailboxRole;
}

/** `jane@x.com:editor; sam@x.com` → members (default access: editor). Problems are returned, not thrown. */
export function parseMembers(raw: string | undefined): { members: MemberSpec[]; problems: string[] } {
  const members: MemberSpec[] = [];
  const problems: string[] = [];
  for (const part of (raw ?? "").split(/[;\n|]/)) {
    const p = part.trim();
    if (!p) continue;
    const i = p.lastIndexOf(":");
    const email = (i > 0 ? p.slice(0, i) : p).trim().toLowerCase();
    const access = parseAccess(i > 0 ? p.slice(i + 1) : "");
    if (!isImportEmail(email)) problems.push(`"${p}" isn't an email address.`);
    else if (!access) problems.push(`Unknown access "${p.slice(i + 1)}" for ${email}. Use owner, editor or viewer.`);
    else if (members.some((m) => m.email === email)) problems.push(`${email} is listed twice.`);
    else members.push({ email, access });
  }
  return { members, problems };
}

export interface UserImportRow {
  email: string;
  name: string;
  role: Role;
  mailbox: string | null;
  jobTitle: string;
  phone: string;
  department: string;
  timezone: string;
  sendInvite: boolean;
}

export interface MailboxImportRow {
  address: string;
  name: string;
  displayName: string;
  type: "personal" | "shared";
  members: MemberSpec[];
}

export interface AliasImportRow {
  address: string;
  mailbox: string;
}

export interface RowCheck<T> {
  value: T | null;
  errors: string[];
  warnings: string[];
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function tooLong(errors: string[], label: string, v: string, max: number) {
  if (v.length > max) errors.push(`${label} is longer than ${max} characters.`);
}

export function checkUserRow(raw: Record<string, unknown>): RowCheck<UserImportRow> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const email = s(raw.email).toLowerCase();
  if (!email) errors.push("Email is missing.");
  else if (!isImportEmail(email)) errors.push(`"${email}" isn't a valid email address.`);
  const role = parseRole(s(raw.role));
  if (!role) errors.push(`Unknown role "${s(raw.role)}". Use member, manager, admin or owner.`);
  const mailbox = s(raw.mailbox).toLowerCase() || null;
  if (mailbox && !isImportEmail(mailbox)) errors.push(`Personal mailbox "${mailbox}" isn't a valid address.`);
  const sendInvite = parseYesNo(s(raw.sendInvite), true);
  if (sendInvite === null) errors.push(`Send invite should be yes or no, not "${s(raw.sendInvite)}".`);
  const name = s(raw.name);
  const jobTitle = s(raw.jobTitle);
  const phone = s(raw.phone);
  const department = s(raw.department);
  const timezone = s(raw.timezone);
  tooLong(errors, "Name", name, 120);
  tooLong(errors, "Job title", jobTitle, 120);
  tooLong(errors, "Phone", phone, 40);
  tooLong(errors, "Department", department, PROFILE_LIMITS.department);
  if (phone && !/^[0-9+().\-\s/x]*$/i.test(phone)) errors.push("Phone can only use digits, spaces and + ( ) -.");
  if (timezone && !isValidTimeZone(timezone)) errors.push(`Unknown time zone "${timezone}". Use a name like Europe/Berlin.`);
  if (!name && email) warnings.push("No name; they can add one when they accept.");
  if (errors.length) return { value: null, errors, warnings };
  return { value: { email, name, role: role!, mailbox, jobTitle, phone, department, timezone, sendInvite: sendInvite! }, errors, warnings };
}

export function checkMailboxRow(raw: Record<string, unknown>): RowCheck<MailboxImportRow> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const address = s(raw.address).toLowerCase();
  if (!address) errors.push("Address is missing.");
  else if (!isImportEmail(address)) errors.push(`"${address}" isn't a valid email address.`);
  const typeRaw = s(raw.type).toLowerCase();
  const type = !typeRaw ? "shared" : typeRaw === "shared" || typeRaw === "personal" ? typeRaw : null;
  if (!type) errors.push(`Unknown type "${typeRaw}". Use shared or personal.`);
  const name = s(raw.name);
  const displayName = s(raw.displayName);
  tooLong(errors, "Mailbox name", name, 80);
  tooLong(errors, "Sender name", displayName, 120);
  const { members, problems } = parseMembers(s(raw.members));
  errors.push(...problems);
  if (members.length > 200) errors.push("A mailbox can be imported with at most 200 members.");
  if (!members.length && address) warnings.push("No members yet; nobody will see this mailbox until you add some.");
  if (errors.length) return { value: null, errors, warnings };
  return { value: { address, name, displayName, type: type!, members }, errors, warnings };
}

export function checkAliasRow(raw: Record<string, unknown>): RowCheck<AliasImportRow> {
  const errors: string[] = [];
  const address = s(raw.address).toLowerCase();
  const mailbox = s(raw.mailbox).toLowerCase();
  if (!address) errors.push("Alias is missing.");
  else if (!isImportEmail(address)) errors.push(`"${address}" isn't a valid email address.`);
  if (!mailbox) errors.push("The mailbox it delivers to is missing.");
  else if (!isImportEmail(mailbox)) errors.push(`"${mailbox}" isn't a valid mailbox address.`);
  if (address && address === mailbox) errors.push("An alias can't point at itself.");
  if (errors.length) return { value: null, errors, warnings: [] };
  return { value: { address, mailbox }, errors, warnings: [] };
}

export const CHECK_ROW = { users: checkUserRow, mailboxes: checkMailboxRow, aliases: checkAliasRow } as const;

/** The key that makes a row unique within one file (duplicates after the first are errors). */
export const ROW_KEY: Record<ImportKind, (row: Record<string, unknown>) => string> = {
  users: (r) => s(r.email).toLowerCase(),
  mailboxes: (r) => s(r.address).toLowerCase(),
  aliases: (r) => s(r.address).toLowerCase(),
};

export type ImportRowStatus = "create" | "skip" | "error";

export interface ImportRowResult {
  /** 1-based data row number in the file (header excluded). */
  row: number;
  key: string;
  status: ImportRowStatus;
  errors: string[];
  warnings: string[];
  /** After a commit: whether it was actually created. */
  done?: boolean;
}

export interface ImportResponse {
  dryRun: boolean;
  results: ImportRowResult[];
  counts: Record<ImportRowStatus, number>;
}

export function countImport(results: ImportRowResult[]): Record<ImportRowStatus, number> {
  const counts: Record<ImportRowStatus, number> = { create: 0, skip: 0, error: 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}
