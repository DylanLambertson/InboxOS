import type { Role } from "@shared/types";

/**
 * The "manager" role is stored as role = 'member' + is_manager = 1 (see migration 0003).
 * Everything outside this file works with the effective Role.
 */

/** SQL expression for the effective role of a users row aliased as `alias`. */
export const roleSql = (alias = "u") => `CASE WHEN ${alias}.role = 'member' AND ${alias}.is_manager = 1 THEN 'manager' ELSE ${alias}.role END`;

export function effectiveRole(row: { role: string; is_manager?: number | null }): Role {
  return row.role === "member" && row.is_manager ? "manager" : (row.role as Role);
}

/** Split an effective role into the columns that store it. */
export function storedRole(role: Role): { role: "owner" | "admin" | "member"; isManager: 0 | 1 } {
  return role === "manager" ? { role: "member", isManager: 1 } : { role, isManager: 0 };
}

/** Owners, admins and managers can open the admin console. */
export const canViewConsole = (r: Role) => r === "owner" || r === "admin" || r === "manager";
/** Only owners and admins can change anything there. */
export const canManage = (r: Role) => r === "owner" || r === "admin";
