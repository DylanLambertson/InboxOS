import { api } from "./api";
import { isStandalone } from "./pwa";

/**
 * Web Push on this device: turn it on/off and keep the server's copy of the
 * subscription fresh (iOS sometimes drops subscriptions, so it's re-sent on start).
 */

const FLAG = "inboxos.pushOn";

export type PushState = "unsupported" | "needs-install" | "server-off" | "denied" | "off" | "on";

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((base64url.length + 3) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
  } catch {
    /* fine */
  }
};

/** Whether this device is getting push (used to skip the duplicate in-tab notification). */
export const pushIsOn = () => {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
};

export async function getPushState(): Promise<PushState> {
  // iPhone/iPad only allow push from an app added to the home screen.
  if (isIos() && !isStandalone()) return "needs-install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  const { publicKey } = await api.get<{ publicKey: string | null }>("push/key");
  if (!publicKey) return "server-off";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Ask permission (must run from a tap), subscribe, and register the device. */
export async function enablePush(): Promise<PushState> {
  const { publicKey } = await api.get<{ publicKey: string | null }>("push/key");
  if (!publicKey) return "server-off";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key can't be reused.
  if (sub && sub.options.applicationServerKey) {
    const current = new Uint8Array(sub.options.applicationServerKey);
    const wanted = keyBytes(publicKey);
    if (current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.post("push/subscribe", sub.toJSON() as Record<string, unknown>);
  remember(true);
  return "on";
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.del("push/subscribe", { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  remember(false);
}

/** On app start: re-send an existing subscription so the server has it (and it follows the signed-in person). */
export async function syncPush(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator) || Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return remember(false);
    await api.post("push/subscribe", sub.toJSON() as Record<string, unknown>);
    remember(true);
  } catch {
    /* offline or push off on the server */
  }
}
