/** Mail rules (filters) shared by the Worker API and the web client. */

export const RULE_FIELDS = ["from", "to", "cc", "recipient", "subject", "body", "header", "has_attachment", "size_gt", "sender_contact"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

/** Fields compared as text with one of RULE_OPERATORS; the rest take a fixed value. */
export const TEXT_FIELDS: readonly RuleField[] = ["from", "to", "cc", "recipient", "subject", "body", "header"];

export const RULE_OPERATORS = ["contains", "not_contains", "equals", "starts_with", "ends_with", "wildcard"] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export interface RuleCondition {
  field: RuleField;
  /** Text fields only. */
  op?: RuleOperator;
  /**
   * Text fields: the text to compare (case-insensitive).
   * has_attachment: "yes" | "no". size_gt: kilobytes. sender_contact: "in" | "not_in".
   */
  value: string;
  /** Header name, for field "header". */
  header?: string;
}

export const RULE_FOLDERS = ["archive", "spam", "trash"] as const;
export type RuleFolder = (typeof RULE_FOLDERS)[number];

export type RuleAction =
  | { type: "label"; labelId: string }
  | { type: "move"; folder: RuleFolder }
  | { type: "read" }
  | { type: "star" }
  | { type: "important" };

export interface MailRuleInput {
  name: string;
  enabled: boolean;
  match: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
  stopProcessing: boolean;
}

export interface MailRule extends MailRuleInput {
  id: string;
  mailboxId: string;
  position: number;
  hits: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MAX_RULES_PER_MAILBOX = 50;
export const MAX_CONDITIONS_PER_RULE = 10;
export const MAX_ACTIONS_PER_RULE = 10;

export const FIELD_LABELS: Record<RuleField, string> = {
  from: "From",
  to: "To",
  cc: "Cc",
  recipient: "To or Cc",
  subject: "Subject",
  body: "Body",
  header: "Header",
  has_attachment: "Has attachment",
  size_gt: "Size larger than (KB)",
  sender_contact: "Sender",
};

export const OPERATOR_LABELS: Record<RuleOperator, string> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "is",
  starts_with: "starts with",
  ends_with: "ends with",
  wildcard: "matches pattern (* ?)",
};

/** Result of a dry run against recent mail. */
export interface RuleTestResult {
  checked: number;
  matches: { id: string; from: string; subject: string; date: string }[];
}
