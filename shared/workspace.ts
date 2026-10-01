/**
 * WORKSPACE: what this install is used for.
 *
 * A use case is a starting point, not a mode: picking one applies a preset theme
 * and turns features on or off, and every individual setting stays editable
 * afterwards (Admin → Appearance for the look, Admin → Features for the switches).
 * Turning a feature off hides it from navigation and the UI; it never deletes data.
 */
import type { OrgPolicy } from "./brand";
import type { ThemeTokens } from "./theme";

export type UseCase = "team" | "agency" | "support" | "personal" | "startup" | "enterprise";

export const FEATURE_KEYS = [
  "sharedInboxes",
  "collaboration",
  "snooze",
  "scheduledSend",
  "templates",
  "contacts",
  "mailRules",
  "outreach",
  "digest",
  "push",
  "allTraffic",
  "compliance",
  "outboundPolicy",
  "provisioning",
  "api",
  "webhooks",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureFlags = Record<FeatureKey, boolean>;

export interface FeatureInfo {
  label: string;
  description: string;
  /** Where it mostly shows up, for grouping in the Features page. */
  group: "Mail" | "Collaboration" | "Administration" | "Developers";
}

export const FEATURES: Record<FeatureKey, FeatureInfo> = {
  sharedInboxes: { label: "Shared inboxes", description: "Team addresses like support@ that several people read and answer.", group: "Collaboration" },
  collaboration: { label: "Assignments, notes & mentions", description: "Assign conversations, leave internal notes and @mention teammates.", group: "Collaboration" },
  snooze: { label: "Snooze", description: "Hide a conversation until a chosen time.", group: "Mail" },
  scheduledSend: { label: "Scheduled send", description: "Write now, deliver later.", group: "Mail" },
  templates: { label: "Templates", description: "Reusable replies for common questions.", group: "Mail" },
  contacts: { label: "Contacts", description: "An address book with notes and tags.", group: "Mail" },
  mailRules: { label: "Mail rules", description: "Filter, label, forward or auto-reply automatically.", group: "Mail" },
  outreach: { label: "Outreach & unsubscribes", description: "Unsubscribe links and a do-not-email list for cold outreach.", group: "Mail" },
  digest: { label: "Unread digests", description: "Daily unread summaries sent to a personal address.", group: "Mail" },
  push: { label: "Push notifications", description: "Phone and desktop notifications for new mail.", group: "Mail" },
  allTraffic: { label: "All traffic view", description: "Admins can see every email across the domain, including unrouted mail.", group: "Administration" },
  compliance: { label: "Compliance", description: "Retention, legal holds and eDiscovery exports.", group: "Administration" },
  outboundPolicy: { label: "Signatures & DLP", description: "Company signatures, disclaimers and outbound data-loss rules.", group: "Administration" },
  provisioning: { label: "SCIM provisioning", description: "Create and remove users from Okta, Entra ID and similar.", group: "Administration" },
  api: { label: "API & MCP", description: "API keys for other services and MCP clients.", group: "Developers" },
  webhooks: { label: "Webhooks", description: "Notify your own services when mail arrives or is sent.", group: "Developers" },
};

const ALL_ON = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as FeatureFlags;

export interface UseCasePreset {
  id: UseCase;
  label: string;
  /** One line shown on the picker card. */
  tagline: string;
  /** lucide-react icon name. */
  icon: string;
  theme: Partial<ThemeTokens>;
  features: Partial<FeatureFlags>;
  /** Sensible policy defaults for this use case (applied once, when the preset is picked). */
  policy: Partial<OrgPolicy>;
}

export const USE_CASE_PRESETS: UseCasePreset[] = [
  {
    id: "team",
    label: "Team",
    tagline: "Personal and shared inboxes for a small company.",
    icon: "Users",
    theme: { accent: "#4f46e5", radius: "md", density: "comfortable" },
    features: { compliance: false, provisioning: false, outreach: false },
    policy: {},
  },
  {
    id: "agency",
    label: "Agency",
    tagline: "Client work across several domains, with outreach built in.",
    icon: "Briefcase",
    theme: { accent: "#0f766e", radius: "lg", density: "comfortable" },
    features: { compliance: false, provisioning: false },
    policy: { trackingEnabled: true },
  },
  {
    id: "support",
    label: "Support desk",
    tagline: "Shared inboxes first: assign, note and answer together.",
    icon: "LifeBuoy",
    theme: { accent: "#2563eb", radius: "sm", density: "compact" },
    features: { outreach: false, compliance: false, provisioning: false },
    policy: {},
  },
  {
    id: "personal",
    label: "Personal & family",
    tagline: "Your own domain, a few addresses, nothing to manage.",
    icon: "Home",
    theme: { accent: "#db2777", radius: "xl", density: "spacious" },
    features: {
      collaboration: false,
      outreach: false,
      allTraffic: false,
      compliance: false,
      outboundPolicy: false,
      provisioning: false,
      api: false,
      webhooks: false,
    },
    policy: {},
  },
  {
    id: "startup",
    label: "Startup",
    tagline: "Founders' mail, investor updates and early customer support.",
    icon: "Rocket",
    theme: { accent: "#ea580c", radius: "md", density: "comfortable" },
    features: { compliance: false, provisioning: false },
    policy: {},
  },
  {
    id: "enterprise",
    label: "Regulated / enterprise",
    tagline: "Everything on: retention, legal hold, DLP, SCIM and required 2FA.",
    icon: "Building2",
    theme: { accent: "#334155", radius: "sm", density: "compact" },
    features: {},
    policy: { require2fa: true, logRetentionDays: 365 },
  },
];

export interface Workspace {
  useCase: UseCase;
  features: FeatureFlags;
}

export const DEFAULT_WORKSPACE: Workspace = { useCase: "team", features: presetFeatures("team") };

export function presetFor(id: UseCase): UseCasePreset {
  return USE_CASE_PRESETS.find((p) => p.id === id) ?? USE_CASE_PRESETS[0];
}

/** The feature switches a use case starts with. */
export function presetFeatures(id: UseCase): FeatureFlags {
  return { ...ALL_ON, ...presetFor(id).features };
}

const isUseCase = (v: unknown): v is UseCase => typeof v === "string" && USE_CASE_PRESETS.some((p) => p.id === v);

/** Coerce a stored or submitted value into a complete, valid workspace. */
export function sanitizeWorkspace(input: unknown, base: Workspace = DEFAULT_WORKSPACE): Workspace {
  const w = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const useCase = isUseCase(w.useCase) ? w.useCase : base.useCase;
  const raw = (w.features && typeof w.features === "object" ? w.features : {}) as Record<string, unknown>;
  const features = { ...base.features };
  for (const k of FEATURE_KEYS) if (typeof raw[k] === "boolean") features[k] = raw[k] as boolean;
  return { useCase, features };
}
