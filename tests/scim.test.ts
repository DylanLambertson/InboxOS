import { describe, expect, it } from "vitest";
import { matchesFilter, parseScimFilter, ScimFilterError } from "../worker/lib/scim-filter";
import {
  appToScim,
  appToState,
  applyPatch,
  emailDomainAllowed,
  listResponse,
  personalMailboxAddress,
  pageParams,
  parseFilterParam,
  parsePatchBody,
  parseScimUser,
  scimErrorBody,
  ScimError,
  scimToApp,
  SCHEMA_ERROR,
  SCHEMA_USER,
  type AppUserLike,
} from "../worker/lib/scim";

const BASE = "https://mail.example.com/scim/v2";
const user: AppUserLike = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada Lovelace",
  status: "active",
  scim_external_id: "00u123",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:00:00.000Z",
};
const resource = appToScim(user, BASE);
const match = (f: string) => matchesFilter(resource, parseScimFilter(f));

describe("SCIM filter parser", () => {
  it("handles the filters Okta and Entra send", () => {
    expect(match('userName eq "ada@example.com"')).toBe(true);
    expect(match('userName eq "ADA@example.com"')).toBe(true); // userName isn't case-exact
    expect(match('userName eq "bob@example.com"')).toBe(false);
    expect(match('emails[type eq "work"].value eq "ada@example.com"')).toBe(true);
    expect(match('emails[type eq "home"].value eq "ada@example.com"')).toBe(false);
    expect(match('emails[value eq "ada@example.com"]')).toBe(true);
    expect(match('emails.value eq "ada@example.com"')).toBe(true);
    expect(match('externalId eq "00u123"')).toBe(true);
    expect(match('externalId eq "00U123"')).toBe(false); // externalId is case-exact
    expect(match("active eq true")).toBe(true);
    expect(match("active eq false")).toBe(false);
    expect(match('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "ada@example.com"')).toBe(true);
  });

  it("supports logic, grouping and the other operators", () => {
    expect(match('userName sw "ada" and active eq true')).toBe(true);
    expect(match('userName eq "x" or (externalId pr and name.givenName eq "Ada")')).toBe(true);
    expect(match('not (userName co "lovelace")')).toBe(true);
    expect(match('userName ew "@example.com"')).toBe(true);
    expect(match('displayName ne "Ada Lovelace"')).toBe(false);
    expect(match("title pr")).toBe(false);
  });

  it("parses escaped strings", () => {
    expect(parseScimFilter('userName eq "a\\"b"')).toEqual({ op: "eq", path: "username", value: 'a"b' });
  });

  it("rejects anything else", () => {
    for (const bad of [
      'userName gt "a"',
      'userName eq',
      'userName eq "a',
      'userName like "a"',
      "userName eq bare",
      '(userName eq "a"',
      'userName eq "a" junk',
      "'; DROP TABLE users; --",
      'emails[type eq "work"',
      "",
      "x".repeat(1001),
      "(".repeat(40) + 'userName eq "a"' + ")".repeat(40),
    ]) {
      expect(() => parseScimFilter(bad), bad.slice(0, 40)).toThrow(ScimFilterError);
    }
  });

  it("maps parser errors to SCIM invalidFilter", () => {
    expect(parseFilterParam(undefined)).toBeNull();
    try {
      parseFilterParam('userName lt "a"');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScimError);
      expect((e as ScimError).status).toBe(400);
      expect((e as ScimError).scimType).toBe("invalidFilter");
    }
  });
});

describe("SCIM ↔ user mapping", () => {
  it("renders a SCIM User resource", () => {
    expect(resource).toMatchObject({
      schemas: [SCHEMA_USER],
      id: "u1",
      externalId: "00u123",
      userName: "ada@example.com",
      name: { formatted: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" },
      emails: [{ value: "ada@example.com", type: "work", primary: true }],
      active: true,
      meta: { resourceType: "User", location: `${BASE}/Users/u1`, created: user.created_at, lastModified: user.updated_at },
    });
    expect(resource.meta.version).toMatch(/^W\/".+"$/);
    expect(appToScim({ ...user, status: "disabled" }, BASE).active).toBe(false);
    expect(appToScim({ ...user, status: "invited" }, BASE).active).toBe(true);
  });

  it("reads Okta and Entra create bodies", () => {
    const okta = parseScimUser({
      schemas: [SCHEMA_USER],
      userName: "Grace@Example.com",
      name: { givenName: "Grace", familyName: "Hopper" },
      emails: [{ primary: true, value: "grace@example.com", type: "work" }],
      displayName: "Grace Hopper",
      active: true,
      externalId: "00uabc",
      locale: "en-US",
    });
    expect(scimToApp(okta)).toEqual({ email: "grace@example.com", name: "Grace Hopper", externalId: "00uabc", active: true });
    // Entra: userName is a non-email UPN alias here, string booleans, enterprise extension.
    const entra = parseScimUser({
      userName: "ghopper",
      active: "False",
      emails: [{ type: "work", value: "grace@example.com", primary: "true" }],
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Navy" },
      name: { formatted: "Rear Admiral Grace Hopper" },
    });
    expect(scimToApp(entra)).toMatchObject({ email: "grace@example.com", name: "Rear Admiral Grace Hopper", active: false });
  });

  it("falls back to displayName and requires an email", () => {
    expect(scimToApp(parseScimUser({ userName: "a@b.co", displayName: "  Al  " })).name).toBe("Al");
    expect(() => scimToApp(parseScimUser({ userName: "nobody" }))).toThrow(/email/);
    expect(() => parseScimUser({ userName: 5 })).toThrow(ScimError);
    expect(() => parseScimUser([])).toThrow(ScimError);
  });
});

describe("SCIM PATCH", () => {
  const start = appToState(user);
  const patch = (ops: unknown) => applyPatch(start, parsePatchBody({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: ops }));

  it("handles Okta's path-less deactivate", () => {
    expect(patch([{ op: "replace", value: { active: false } }]).active).toBe(false);
  });

  it("handles Entra's capitalized ops and string booleans", () => {
    expect(patch([{ op: "Replace", path: "active", value: "False" }]).active).toBe(false);
    expect(patch([{ op: "Replace", path: "active", value: "True" }]).active).toBe(true);
    expect(() => patch([{ op: "Replace", path: "active", value: "nope" }])).toThrow(ScimError);
  });

  it("sets names, emails and externalId by path", () => {
    const s = patch([
      { op: "Add", path: "name.givenName", value: "Augusta" },
      { op: "Add", path: "name.familyName", value: "King" },
      { op: "Replace", path: 'emails[type eq "work"].value', value: "augusta@example.com" },
      { op: "Replace", path: "externalId", value: "abc-1" },
    ]);
    const m = scimToApp({ ...s, userName: undefined });
    expect(m.email).toBe("augusta@example.com");
    expect(s.name).toMatchObject({ givenName: "Augusta", familyName: "King" });
    expect(s.externalId).toBe("abc-1");
    expect(m.name).toBe("Augusta King");
    expect(scimToApp(patch([{ op: "Replace", path: "name.givenName", value: "Augusta" }])).name).toBe("Augusta Lovelace");
    // A custom formatted name set alongside stays.
    expect(scimToApp(patch([{ op: "replace", path: "name.formatted", value: "Lady Ada" }, { op: "replace", path: "name.givenName", value: "Augusta" }])).name).toBe("Lady Ada");
  });

  it("names: formatted wins, else given + family", () => {
    const s = applyPatch({ ...start, name: {} }, [{ op: "replace", path: "name", value: { givenName: "A", familyName: "B" } }]);
    expect(scimToApp(s).name).toBe("A B");
  });

  it("accepts path-less objects with dotted keys", () => {
    const s = patch([{ op: "replace", value: { "name.formatted": "Lady Ada", displayName: "Ada", "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department": "x" } }]);
    expect(scimToApp(s).name).toBe("Lady Ada");
  });

  it("creates a missing email element from the filter", () => {
    const s = applyPatch({ ...start, emails: [] }, [{ op: "add", path: 'emails[type eq "work"].value', value: "new@example.com" }]);
    expect(s.emails).toEqual([{ value: "new@example.com", type: "work" }]);
  });

  it("removes", () => {
    expect(patch([{ op: "remove", path: 'emails[type eq "work"]' }]).emails).toEqual([]);
    expect(patch([{ op: "remove", path: "externalId" }]).externalId).toBeNull();
    // Removing active doesn't deactivate.
    expect(patch([{ op: "remove", path: "active" }]).active).toBe(true);
    expect(() => patch([{ op: "remove" }])).toThrow(/path/);
  });

  it("ignores attributes it doesn't store and rejects malformed operations", () => {
    expect(patch([{ op: "replace", path: "title", value: "Countess" }])).toEqual(start);
    expect(() => patch([{ op: "move", path: "active", value: true }])).toThrow(ScimError);
    expect(() => patch([{ op: "replace", path: 'emails[type eq "work"', value: "x" }])).toThrow(ScimError);
    expect(() => parsePatchBody({ Operations: [] })).toThrow(ScimError);
    expect(() => parsePatchBody({})).toThrow(ScimError);
  });

  it("never mutates the starting state", () => {
    patch([{ op: "replace", value: { active: false, displayName: "x" } }]);
    expect(start.active).toBe(true);
  });
});

describe("SCIM provisioning guards", () => {
  const domains = ["example.com", "example.org"];
  it("only gives team-domain people a personal mailbox, never a role address", () => {
    expect(personalMailboxAddress("jane@example.org", domains)).toBe("jane@example.com");
    expect(personalMailboxAddress("Jane.Doe@example.com", domains)).toBe("jane.doe@example.com");
    expect(personalMailboxAddress("jane@gmail.com", domains)).toBeNull();
    expect(personalMailboxAddress("postmaster@example.com", domains)).toBeNull();
    expect(personalMailboxAddress("a+b@example.com", domains)).toBeNull();
    expect(personalMailboxAddress("jane@example.com", [])).toBeNull();
  });
  it("only moves members onto allowed domains", () => {
    expect(emailDomainAllowed("x@Example.org", domains)).toBe(true);
    expect(emailDomainAllowed("x@evil.example", domains)).toBe(false);
  });
  it("a displayName-only PATCH renames an existing user", () => {
    expect(scimToApp(applyPatch(appToState(user), [{ op: "Replace", path: "displayName", value: "Countess Ada" }])).name).toBe("Countess Ada");
  });
});

describe("SCIM responses", () => {
  it("formats errors per RFC 7644 §3.12", () => {
    expect(scimErrorBody(409, "taken", "uniqueness")).toEqual({ schemas: [SCHEMA_ERROR], status: "409", scimType: "uniqueness", detail: "taken" });
    expect(scimErrorBody(404, "nope")).toEqual({ schemas: [SCHEMA_ERROR], status: "404", detail: "nope" });
  });

  it("pages list responses with a 1-based startIndex", () => {
    const items = Array.from({ length: 5 }, (_, i) => i + 1);
    expect(listResponse(items, 2, 2)).toMatchObject({ totalResults: 5, startIndex: 2, itemsPerPage: 2, Resources: [2, 3] });
    expect(listResponse(items, 1, 0)).toMatchObject({ totalResults: 5, itemsPerPage: 0, Resources: [] });
    expect(pageParams(undefined, undefined)).toEqual({ start: 1, count: 100 });
    expect(pageParams("0", "-5")).toEqual({ start: 1, count: 0 });
    expect(pageParams("3", "9999")).toEqual({ start: 3, count: 200 });
  });
});
