import { toast } from "sonner";

/**
 * The installable-app plumbing: registers /sw.js (production only), offers a reload
 * when a new version is deployed, and gives the rest of the app a way to show
 * notifications that works on phones (they require a service worker).
 */

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const offerUpdate = (worker: ServiceWorker) =>
        toast("A new version is ready", {
          duration: Infinity,
          action: { label: "Reload", onClick: () => worker.postMessage("SKIP_WAITING") },
        });
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        next?.addEventListener("statechange", () => {
          if (next.state === "installed" && navigator.serviceWorker.controller) offerUpdate(next);
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!reloading) (reloading = true), window.location.reload();
      });
      // Check for a new deploy when the app comes back to the foreground.
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reg.update().catch(() => undefined));
    } catch {
      /* the app works without it */
    }
  });
}

/** On sign-out, drop the cached shell so a shared phone keeps nothing. */
export function clearAppCache() {
  navigator.serviceWorker?.controller?.postMessage("CLEAR_CACHE");
}

/** Show a notification through the service worker when there is one (required on Android/iOS). */
export async function showAppNotification(title: string, options: NotificationOptions & { data?: { url?: string } }) {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (reg) return reg.showNotification(title, options);
  const n = new Notification(title, options);
  n.onclick = () => {
    window.focus();
    if (options.data?.url) window.location.assign(options.data.url);
    n.close();
  };
}

/** Running as an installed app (home screen), not in a browser tab. */
export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
