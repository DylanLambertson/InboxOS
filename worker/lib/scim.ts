import { normalizePath, parseScimFilter, matchesFilter, ScimFilterError, type ScimFilter } from "./scim-filter";

/**
 * SCIM 2.0 (RFC 7643/7644) resource mapping and PATCH handling, kept free of D1 so it can be
 * unit-tested. Identity providers disagree on details; the quirks handled here are noted inline.
 */

export const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";
export const MAX_PAGE = 200;

export type ScimErrorType = "invalidFilter" | "invalidSyntax" | "invalidPath" | "invalidValue" | "noTarget" | "uniqueness" | "mutability" | "tooMany";

export class ScimError extends Error {
  constructor(
    public status: number,
    message: string,
    public scimType?: ScimErrorType,
  ) {
    super(message);
  }
}

export function scimErrorBody(status: number, detail: string, scimType?: ScimErrorType) {
  // RFC 7644 §3.12: status is a string.
  return { schemas: [SCHEMA_ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail };
}

/** The attributes of a user that SCIM can set. */
export interface ScimUserState {
  userName?: string;
  externalId?: string | null;
  active?: boolean;
  displayName?: string;
  name: { formatted?: string; givenName?: string; familyName?: string };
  emails: { value: string; type?: string; primary?: boolean }[];
}

export interface AppUserLike {
  id: string;
  email: string;
  name: string;
  status: "active" | "invited" | "disabled";
  scim_external_id: string | null;
  created_at: string;
  updated_at: string;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Entra sends booleans as "True"/"False" strings. */
export function scimBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === "true";
  throw new ScimError(400, "active must be true or false", "invalidValue");
}

const str = (v: unknown, field: string, max = 254): string => {
  if (typeof v !== "string") throw new ScimError(400, `${field} must be a string`, "invalidValue");
  if (v.length > max) throw new ScimError(400, `${field} is too long`, "invalidValue");
  return v.trim();
};

function parseEmails(v: unknown): ScimUserState["emails"] {
  if (!Array.isArray(v)) throw new ScimError(400, "emails must be a list", "invalidValue");
  return v.slice(0, 20).map((e) => {
    if (!e || typeof e !== "object") throw new ScimError(400, "emails entries must be objects", "invalidValue");
    const o = e as Record<string, unknown>;
    return {
      value: str(o.value ?? "", "emails.value"),
      ...(typeof o.type === "string" ? { type: o.type.slice(0, 40) } : {}),
      ...(o.primary !== undefined ? { primary: scimBool(o.primary) } : {}),
    };
  });
}

/** Read the attributes we use from a SCIM User body (POST/PUT). Unknown attributes are ignored. */
export function parseScimUser(body: unknown): ScimUserState {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScimError(400, "Body must be a SCIM User object", "invalidSyntax");
  const state: ScimUserState = { name: {}, emails: [] };
  for (const [k, v] of Object.entries(body)) applyAttr(state, "replace", normalizePath(k), v);
  return state;
}

/** Set (or with `remove`, clear) one attribute path on the state. */
function applyAttr(state: ScimUserState, op: "add" | "replace" | "remove", path: string, value: unknown): void {
  const remove = op === "remove";
  switch (path) {
    case "username":
      if (remove) throw new ScimError(400, "userName can't be removed", "mutability");
      state.userName = str(value, "userName");
      return;
    case "externalid":
      state.externalId = remove || value === null ? null : str(value, "externalId", 255);
      return;
    case "active":
      // Removing "active" leaves it unchanged rather than silently deactivating someone.
      if (!remove) state.active = scimBool(value);
      return;
    case "displayname":
      state.displayName = remove ? "" : str(value, "displayName", 120);
      return;
    case "name":
      if (remove) state.name = {};
      else if (value && typeof value === "object" && !Array.isArray(value)) {
        const next = op === "add" ? { ...state.name } : {};
        for (const [k, v] of Object.entries(value)) applyNamePart(next, k.toLowerCase(), v);
        state.name = next;
      } else throw new ScimError(400, "name must be an object", "invalidValue");
      return;
    case "name.formatted":
    case "name.givenname":
    case "name.familyname": {
      // Entra patches givenName/familyName alone; a formatted name built from them must follow.
      const n = state.name;
      const derived = path !== "name.formatted" && n.formatted === [n.givenName, n.familyName].filter(Boolean).join(" ");
      applyNamePart(n, path.slice(5), remove ? "" : value);
      if (derived) delete n.formatted;
      return;
    }
    case "emails":
      if (remove) state.emails = [];
      else {
        const list = parseEmails(Array.isArray(value) ? value : [value]);
        // add merges by value; replace swaps the list.
        state.emails = op === "add" ? [...state.emails.filter((e) => !list.some((n) => n.value.toLowerCase() === e.value.toLowerCase())), ...list] : list;
      }
      return;
    default:
      // schemas, meta, id, phoneNumbers, enterprise extension, etc.: accepted and ignored so
      // a provider mapping extra attributes doesn't fail every sync.
      return;
  }
}

function applyNamePart(name: ScimUserState["name"], part: string, v: unknown) {
  const s = v === null || v === undefined ? "" : str(v, `name.${part}`, 120);
  if (part === "formatted") name.formatted = s;
  else if (part === "givenname") name.givenName = s;
  else if (part === "familyname") name.familyName = s;
}

export interface PatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

/** Validate a PatchOp request body and return its operations. */
export function parsePatchBody(body: unknown): PatchOperation[] {
  const b = body as { Operations?: unknown; operations?: unknown } | null;
  const ops = b && typeof b === "object" ? (b.Operations ?? b.operations) : undefined;
  if (!Array.isArray(ops) || !ops.length) throw new ScimError(400, "Operations must be a non-empty list", "invalidSyntax");
  if (ops.length > 100) throw new ScimError(400, "Too many operations", "tooMany");
  return ops.map((o) => {
    if (!o || typeof o !== "object") throw new ScimError(400, "Each operation must be an object", "invalidSyntax");
    const { op, path, value } = o as Record<string, unknown>;
    if (typeof op !== "string") throw new ScimError(400, "Each operation needs an op", "invalidSyntax");
    if (path !== undefined && typeof path !== "string") throw new ScimError(400, "path must be a string", "invalidPath");
    return { op, path: path as string | undefined, value };
  });
}

/** `emails[type eq "work"].value` → { attr: "emails", filter, sub: "value" }. */
function splitValuePath(path: string): { attr: string; filter: ScimFilter; sub?: string } | null {
  const m = /^([^[\]]+)\[(.+)\](?:\.([A-Za-z$][\w$-]*))?$/s.exec(path.trim());
  if (!m) return null;
  try {
    return { attr: normalizePath(m[1]), filter: parseScimFilter(m[2]), sub: m[3]?.toLowerCase() };
  } catch (e) {
    throw new ScimError(400, e instanceof ScimFilterError ? e.message : "Invalid path", "invalidPath");
  }
}

/**
 * Apply PATCH operations (RFC 7644 §3.5.2) to a copy of the state. Handles the provider quirks:
 * Entra's capitalized ops ("Replace") and string booleans ("False"), path-less value objects
 * (Okta's `{"op":"replace","value":{"active":false}}`), and dotted keys inside them.
 */
export function applyPatch(current: ScimUserState, ops: PatchOperation[]): ScimUserState {
  const state: ScimUserState = structuredClone(current);
  for (const raw of ops) {
    const op = raw.op.toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") throw new ScimError(400, `Unknown op "${raw.op}"`, "invalidSyntax");
    const path = raw.path?.trim();
    if (!path) {
      if (op === "remove") throw new ScimError(400, "remove needs a path", "noTarget");
      if (!raw.value || typeof raw.value !== "object" || Array.isArray(raw.value)) throw new ScimError(400, "A value object is required when there's no path", "invalidValue");
      for (const [k, v] of Object.entries(raw.value)) applyAttr(state, op, normalizePath(k), v);
      continue;
    }
    const vp = splitValuePath(path);
    if (!vp) {
      if (!/^(urn:[\w:.-]+:)?[A-Za-z$][\w$-]*(\.[A-Za-z$][\w$-]*)?$/.test(path)) throw new ScimError(400, `Invalid path "${path.slice(0, 100)}"`, "invalidPath");
      if (op !== "remove" && raw.value === undefined) throw new ScimError(400, `No value for ${path}`, "invalidValue");
      applyAttr(state, op, normalizePath(path), raw.value);
      continue;
    }
    if (vp.attr !== "emails") continue; // other multi-valued attributes aren't stored
    const hits = state.emails.filter((e) => matchesFilter(e, vp.filter));
    if (op === "remove") {
      state.emails = vp.sub ? state.emails : state.emails.filter((e) => !hits.includes(e));
      continue;
    }
    if (vp.sub && vp.sub !== "value" && vp.sub !== "type" && vp.sub !== "primary") continue;
    if (!hits.length) {
      // Entra adds a work email with `emails[type eq "work"].value`; create the element it describes.
      const seed = seedFromFilter(vp.filter);
      const el = { value: "", ...seed };
      state.emails.push(el);
      hits.push(el);
    }
    for (const el of hits) {
      if (!vp.sub) Object.assign(el, parseEmails([raw.value])[0]);
      else if (vp.sub === "value") el.value = str(raw.value, "emails.value");
      else if (vp.sub === "type") el.type = str(raw.value, "emails.type", 40);
      else el.primary = scimBool(raw.value);
    }
    state.emails = state.emails.filter((e) => e.value);
  }
  return state;
}

/** Equality terms of a simple filter (`type eq "work" and primary eq true`) as element fields. */
function seedFromFilter(f: ScimFilter): { type?: string; primary?: boolean } {
  if (f.op === "and") return { ...seedFromFilter(f.left), ...seedFromFilter(f.right) };
  if (f.op === "eq" && f.path === "type" && typeof f.value === "string") return { type: f.value };
  if (f.op === "eq" && f.path === "primary" && typeof f.value === "boolean") return { primary: f.value };
  return {};
}

const isEmail = (s: string | undefined): s is string => !!s && EMAIL_RE.test(s);

/**
 * The app account a SCIM state describes. userName is the sign-in email (Okta's default, and what
 * Entra sends when userName is mapped to mail or a UPN that matches it); otherwise the primary,
 * then work, then first email.
 */
export function scimToApp(state: ScimUserState): { email: string; name: string; externalId: string | null | undefined; active: boolean | undefined } {
  const candidates = [state.userName, state.emails.find((e) => e.primary)?.value, state.emails.find((e) => e.type?.toLowerCase() === "work")?.value, state.emails[0]?.value];
  const email = candidates.find((c) => isEmail(c?.trim()))?.trim().toLowerCase();
  if (!email) throw new ScimError(400, "userName (or a primary email) must be an email address", "invalidValue");
  const n = state.name;
  const name = (n.formatted || [n.givenName, n.familyName].filter(Boolean).join(" ") || state.displayName || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return { email, name, externalId: state.externalId, active: state.active };
}

/** Best-effort split of a display name for providers that only read givenName/familyName. */
function splitName(name: string): { givenName: string; familyName: string } {
  const i = name.lastIndexOf(" ");
  return i > 0 ? { givenName: name.slice(0, i), familyName: name.slice(i + 1) } : { givenName: name, familyName: "" };
}

/** Weak ETag from the row's last change. */
export const userEtag = (u: Pick<AppUserLike, "updated_at">) => `W/"${Date.parse(u.updated_at).toString(36)}"`;

/** The SCIM representation of an app user. */
export function appToScim(u: AppUserLike, baseUrl: string) {
  const parts = splitName(u.name);
  return {
    schemas: [SCHEMA_USER],
    id: u.id,
    ...(u.scim_external_id ? { externalId: u.scim_external_id } : {}),
    userName: u.email,
    name: { formatted: u.name, ...parts },
    displayName: u.name || u.email,
    emails: [{ value: u.email, type: "work", primary: true }],
    active: u.status !== "disabled",
    meta: { resourceType: "User", created: u.created_at, lastModified: u.updated_at, location: `${baseUrl}/Users/${u.id}`, version: userEtag(u) },
  };
}

/** The editable state of an existing user, as PATCH starts from. */
export function appToState(u: AppUserLike): ScimUserState {
  return {
    userName: u.email,
    externalId: u.scim_external_id,
    active: u.status !== "disabled",
    displayName: u.name,
    name: { formatted: u.name, ...splitName(u.name) },
    emails: [{ value: u.email, type: "work", primary: true }],
  };
}

/** Clamp RFC 7644 paging parameters: 1-based startIndex, count capped. */
export function pageParams(startIndex: string | undefined, count: string | undefined): { start: number; count: number } {
  const s = Number.parseInt(startIndex ?? "", 10);
  const n = Number.parseInt(count ?? "", 10);
  return { start: Number.isFinite(s) && s > 1 ? s : 1, count: Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_PAGE) : 100 };
}

export function listResponse<T>(all: T[], start: number, count: number) {
  const page = all.slice(start - 1, start - 1 + count);
  return { schemas: [SCHEMA_LIST], totalResults: all.length, startIndex: start, itemsPerPage: page.length, Resources: page };
}

/** Parse a `filter` query parameter, mapping parser errors to SCIM invalidFilter. */
export function parseFilterParam(raw: string | undefined): ScimFilter | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    return parseScimFilter(raw);
  } catch (e) {
    throw new ScimError(400, e instanceof ScimFilterError ? e.message : "Invalid filter", "invalidFilter");
  }
}

// ---- Discovery documents (RFC 7644 §4) ------------------------------------------------------

export function serviceProviderConfig(docsUrl: string) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: docsUrl,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: true },
    authenticationSchemes: [
      { type: "oauthbearertoken", name: "Bearer token", description: "The SCIM token from Admin → Provisioning, sent as Authorization: Bearer <token>.", primary: true },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: "/ServiceProviderConfig" },
  };
}

export function resourceTypes(baseUrl: string) {
  return [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: "/Users",
      description: "Team members",
      schema: SCHEMA_USER,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` },
    },
  ];
}

const attr = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

export function userSchema(baseUrl: string) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: SCHEMA_USER,
    name: "User",
    description: "Team member account",
    attributes: [
      attr("userName", { required: true, uniqueness: "server", description: "Sign-in email address" }),
      attr("externalId", { caseExact: true }),
      attr("name", {
        type: "complex",
        subAttributes: [attr("formatted"), attr("givenName"), attr("familyName")],
      }),
      attr("displayName"),
      attr("active", { type: "boolean" }),
      attr("emails", {
        type: "complex",
        multiValued: true,
        subAttributes: [attr("value"), attr("type", { canonicalValues: ["work"] }), attr("primary", { type: "boolean" })],
      }),
    ],
    meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCHEMA_USER}` },
  };
}
