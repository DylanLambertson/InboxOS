import { ACCESS_NAME, type BulkRowStatus, type UserBulkAction, type UserBulkParams } from "@shared/admin";
import type { MailboxRole, Role, UserStatus } from "@shared/types";
import { losesOwner, manageProblem, userChangeProblem, type Actor } from "./user-admin";

/**
 * Bulk user actions, decided row by row before anything is written: what will
 * happen to each person and why some are skipped or refused. The same rules as
 * the single-user actions (see user-admin.ts), including "never remove the last
 * active owner", which is tracked across the whole batch.
 */

export interface BulkTarget {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  totpEnabled: boolean;
}

export interface BulkContext {
  activeOwners: number;
  /** People under an active legal hold (can't be deleted). */
  heldUserIds: Set<string>;
  /** For mailbox actions: each target's current access to that mailbox. */
  membership: Map<string, MailboxRole>;
}

export interface PlannedRow {
  target: BulkTarget;
  status: BulkRowStatus;
  message?: string;
}

const ROLE_NAME: Record<Role, string> = { owner: "an owner", admin: "an admin", manager: "a manager", member: "a member" };

/** Why the params don't fit the action, or null. */
export function bulkParamsProblem(action: UserBulkAction, p: UserBulkParams): string | null {
  if (action === "role" && !p.role) return "Choose a role.";
  if ((action === "add_mailbox" || action === "remove_mailbox") && !p.mailboxId) return "Choose a mailbox.";
  if (action === "add_mailbox" && !p.access) return "Choose an access level.";
  return null;
}

export function planUserBulk(actor: Actor, targets: BulkTarget[], action: UserBulkAction, params: UserBulkParams, ctx: BulkContext): PlannedRow[] {
  let owners = ctx.activeOwners;
  const ok = (target: BulkTarget, message?: string): PlannedRow => ({ target, status: "ok", message });
  const skip = (target: BulkTarget, message: string): PlannedRow => ({ target, status: "skipped", message });
  const fail = (target: BulkTarget, message: string): PlannedRow => ({ target, status: "failed", message });

  return targets.map((t) => {
    const manage = manageProblem(actor, t);
    if (manage) return fail(t, manage);
    switch (action) {
      case "role": {
        const role = params.role!;
        if (t.role === role) return skip(t, `Already ${ROLE_NAME[role]}.`);
        const problem = userChangeProblem(actor, t, { role }, owners);
        if (problem) return fail(t, problem);
        if (losesOwner(t, { role })) owners--;
        return ok(t, `Becomes ${ROLE_NAME[role]}.`);
      }
      case "disable": {
        if (t.status === "disabled") return skip(t, "Already disabled.");
        const problem = userChangeProblem(actor, t, { status: "disabled" }, owners);
        if (problem) return fail(t, problem);
        if (losesOwner(t, { status: "disabled" })) owners--;
        return ok(t, "Signed out and blocked from signing in.");
      }
      case "enable":
        return t.status === "disabled" ? ok(t, "Can sign in again.") : skip(t, "Not disabled.");
      case "resend_invite":
        return t.status === "invited" ? ok(t, "Gets a new invite link by email.") : skip(t, t.status === "active" ? "Already joined." : "Disabled.");
      case "reset_2fa":
        return t.totpEnabled ? ok(t, "Two-factor turned off; signed out.") : skip(t, "Two-factor isn't set up.");
      case "sign_out":
        return t.id === actor.id ? skip(t, "That's you. Use Sign out instead.") : ok(t, "Signed out on every device.");
      case "add_mailbox": {
        const current = ctx.membership.get(t.id);
        if (current === params.access) return skip(t, "Already has this access.");
        const next = ACCESS_NAME[params.access!];
        return ok(t, current ? `Access changes from ${ACCESS_NAME[current]} to ${next}.` : `Gets ${next} access.`);
      }
      case "remove_mailbox":
        return ctx.membership.has(t.id) ? ok(t, "Loses access.") : skip(t, "Doesn't have access.");
      case "delete": {
        const problem = userChangeProblem(actor, t, { delete: true }, owners);
        if (problem) return fail(t, problem);
        if (ctx.heldUserIds.has(t.id)) return fail(t, "Under legal hold. Disable them instead, or release the hold first.");
        if (losesOwner(t, { delete: true })) owners--;
        return ok(t, "Account removed. Mailboxes and mail are kept.");
      }
    }
  });
}
