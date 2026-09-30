import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { api } from "@/lib/api";

export const passkeysSupported = () => browserSupportsWebAuthn();
export const cancelPasskeyPrompt = () => WebAuthnAbortService.cancelCeremony();

/** True when the user closed or cancelled the browser's passkey sheet: not worth an error. */
export function isPasskeyCancel(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { name?: string } } | null;
  if (e?.code === "ERROR_CEREMONY_ABORTED") return true;
  const name = e?.cause?.name ?? e?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

/**
 * Sign in with a passkey. `autofill` waits quietly for the user to pick one from the
 * email field's suggestions (conditional UI) instead of opening the browser's sheet.
 * Resolves false when this browser can't do autofill.
 */
export async function signInWithPasskey(autofill = false, isLive: () => boolean = () => true): Promise<boolean> {
  if (autofill && !(await browserSupportsWebAuthnAutofill())) return false;
  // A run that was cancelled while awaiting must not start a ceremony: it would abort the live one.
  if (!isLive()) return false;
  const optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>("/api/auth/passkey/options");
  if (!isLive()) return false;
  const response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
  await api.post("/api/auth/passkey/verify", response as unknown as Record<string, unknown>);
  return true;
}

/** Create a passkey on this device for the signed-in user. */
export async function addPasskey(name: string, reauth: { password?: string; code?: string } = {}): Promise<void> {
  const optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>("me/passkeys/options", reauth);
  const response = await startRegistration({ optionsJSON });
  await api.post("me/passkeys", { name, response: response as unknown as Record<string, unknown> });
}
