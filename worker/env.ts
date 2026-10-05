import type { Role } from "@shared/types";
import type { ApiKey, RequestScope } from "./lib/apikeys";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_URL: string;
  SESSION_SECRET: string;
  /** Optional: when unset, the key entered in the setup wizard is used (see lib/provider-config.ts). */
  RESEND_API_KEY?: string;
  /** Optional: when unset, the secret captured by the setup wizard is used. */
  RESEND_WEBHOOK_SECRET?: string;
  /** Optional key for creating the first owner in the setup wizard; SESSION_SECRET is used when unset. */
  SETUP_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Where to POST a signed notice when mail arrives (e.g. another service's receiver). */
  NOTIFY_WEBHOOK_URL?: string;
  NOTIFY_WEBHOOK_SECRET?: string;
  /** VAPID private key (JWK JSON) for Web Push; the public key is derived from it. Unset = push off. */
  VAPID_PRIVATE_JWK?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; apiKey: ApiKey; scope: RequestScope; scimTokenId: string };
};
