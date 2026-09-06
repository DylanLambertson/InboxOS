import { describe, expect, it } from "vitest";
import { canManage, canViewConsole, effectiveRole, storedRole } from "../worker/lib/roles";

describe("roles", () => {
  it("stores manager as member + flag and reads it back", () => {
    expect(storedRole("manager")).toEqual({ role: "member", isManager: 1 });
    expect(effectiveRole({ role: "member", is_manager: 1 })).toBe("manager");
  });
  it("clears the flag for every other role", () => {
    for (const r of ["owner", "admin", "member"] as const) expect(storedRole(r)).toEqual({ role: r, isManager: 0 });
  });
  it("never lets the flag elevate or change admins/owners", () => {
    expect(effectiveRole({ role: "admin", is_manager: 1 })).toBe("admin");
    expect(effectiveRole({ role: "owner", is_manager: 1 })).toBe("owner");
    expect(effectiveRole({ role: "member", is_manager: 0 })).toBe("member");
  });
  it("gives managers view-only console access", () => {
    expect(canViewConsole("manager")).toBe(true);
    expect(canManage("manager")).toBe(false);
    expect(canViewConsole("member")).toBe(false);
    expect(canManage("admin") && canManage("owner")).toBe(true);
  });
});
