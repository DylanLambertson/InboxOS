import type { Role } from "@shared/types";
import type { ApiKey } from "./lib/apikeys";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_URL: string;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
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
  Variables: { user: SessionUser; apiKey: ApiKey };
};
