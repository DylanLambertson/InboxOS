/**
 * FIRST-RUN SETUP
 *
 * The steps of the setup wizard and how each one's completion is derived from real
 * state (not from clicks), shared by the worker (GET /api/setup/status) and the app.
 */
import type { UseCase } from "./workspace";

export const SETUP_STEPS = ["owner", "useCase", "brand", "provider", "domains", "receiving", "mailboxes", "team", "test", "done"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];
export type StepState = "done" | "skipped" | "todo";

export interface SetupStepInfo {
  label: string;
  /** One line under the label in the step list. */
  hint: string;
}

export const STEP_INFO: Record<SetupStepId, SetupStepInfo> = {
  owner: { label: "Your account", hint: "Create the owner account" },
  useCase: { label: "Use case", hint: "What you'll use it for" },
  brand: { label: "Brand", hint: "Name, logo and color" },
  provider: { label: "Email provider", hint: "Connect Resend" },
  domains: { label: "Domains", hint: "Add and verify your domains" },
  receiving: { label: "Receiving", hint: "Get incoming mail" },
  mailboxes: { label: "Mailboxes", hint: "Your inbox and shared ones" },
  team: { label: "Team", hint: "Invite people" },
  test: { label: "Test", hint: "Send and receive a test" },
  done: { label: "Done", hint: "What's next" },
};

export const isSetupStep = (v: unknown): v is SetupStepId => typeof v === "string" && (SETUP_STEPS as readonly string[]).includes(v);

/** What the step states are derived from. Gathered from the database and provider config. */
export interface SetupFacts {
  ownerExists: boolean;
  /** A use case was saved (the workspace setting exists). */
  useCaseChosen: boolean;
  /** The company name has been filled in. */
  brandNamed: boolean;
  apiKeyConfigured: boolean;
  primaryDomain: string;
  /** Every mail domain with its last known provider status (null = not in the provider yet). */
  domains: { name: string; status: string | null }[];
  webhookConfigured: boolean;
  mailboxCount: number;
  userCount: number;
  testPassed: boolean;
  completedAt: string | null;
  skipped: SetupStepId[];
}

/** Each step's state. A step that is actually done counts as done even if it was skipped earlier. */
export function deriveSteps(f: SetupFacts): Record<SetupStepId, StepState> {
  const done: Record<SetupStepId, boolean> = {
    owner: f.ownerExists,
    useCase: f.useCaseChosen,
    brand: f.brandNamed,
    provider: f.apiKeyConfigured,
    domains: !!f.primaryDomain && f.domains.length > 0 && f.domains.every((d) => d.status === "verified"),
    receiving: f.webhookConfigured,
    mailboxes: f.mailboxCount > 0,
    team: f.userCount > 1,
    test: f.testPassed,
    done: !!f.completedAt,
  };
  const skipped = new Set(f.skipped);
  return Object.fromEntries(SETUP_STEPS.map((s) => [s, done[s] ? "done" : skipped.has(s) ? "skipped" : "todo"])) as Record<SetupStepId, StepState>;
}

/** The first step still to do (skipped steps are passed over), or "done". */
export function nextStep(steps: Record<SetupStepId, StepState>): SetupStepId {
  return SETUP_STEPS.find((s) => s !== "done" && steps[s] === "todo") ?? "done";
}

/** Share of the working steps (everything but "done") that are finished, 0–100. */
export function setupProgress(steps: Record<SetupStepId, StepState>): number {
  const work = SETUP_STEPS.filter((s) => s !== "done");
  return Math.round((work.filter((s) => steps[s] === "done").length / work.length) * 100);
}

/** The steps that are needed for mail to flow at all. */
export const ESSENTIAL_STEPS: SetupStepId[] = ["owner", "provider", "domains", "receiving", "mailboxes"];

/** Public answer of GET /api/setup/status. */
export interface PublicSetupStatus {
  ownerExists: boolean;
  completed: boolean;
  /** The owner hid the "finish setup" banner. */
  dismissed: boolean;
  steps: Record<SetupStepId, StepState>;
  nextStep: SetupStepId;
  progress: number;
  /** Where the setup key comes from, so the owner step can say where to find it. */
  setupKeySource: "SETUP_TOKEN" | "SESSION_SECRET";
}

/** Shared inboxes suggested for each use case (local parts). */
export const SUGGESTED_MAILBOXES: Record<UseCase, { local: string; name: string }[]> = {
  team: [
    { local: "hello", name: "Hello" },
    { local: "team", name: "Team" },
  ],
  agency: [
    { local: "hello", name: "Hello" },
    { local: "projects", name: "Projects" },
    { local: "billing", name: "Billing" },
  ],
  support: [
    { local: "support", name: "Support" },
    { local: "billing", name: "Billing" },
  ],
  personal: [{ local: "hello", name: "Hello" }],
  startup: [
    { local: "hello", name: "Hello" },
    { local: "founders", name: "Founders" },
    { local: "support", name: "Support" },
  ],
  enterprise: [
    { local: "info", name: "Info" },
    { local: "it", name: "IT" },
    { local: "privacy", name: "Privacy" },
  ],
};

/** Regions Resend can send from. */
export const RESEND_REGIONS = [
  { id: "us-east-1", label: "North America (us-east-1)" },
  { id: "eu-west-1", label: "Europe (eu-west-1)" },
  { id: "sa-east-1", label: "South America (sa-east-1)" },
  { id: "ap-northeast-1", label: "Asia Pacific (ap-northeast-1)" },
] as const;
export type ResendRegion = (typeof RESEND_REGIONS)[number]["id"];

/** Every email.* event the app handles; the webhook subscribes to all of them. */
export const WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.received",
  "email.scheduled",
  "email.suppressed",
] as const;

/** Domain names people may add: lowercase labels with a dot and a TLD. */
export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
