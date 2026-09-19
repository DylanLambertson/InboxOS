import { useEffect, useState } from "react";
import { Share, SquarePlus, X } from "lucide-react";
import { useBrand } from "@/lib/brand";
import { isStandalone } from "@/lib/pwa";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/overlay";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const KEY = "inboxos.installDismissed";
const QUIET_DAYS = 30;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(KEY) ?? 0);
    return Date.now() - at < QUIET_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

const isIosSafari = () => {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
};

/**
 * On phones, a small banner offering to put the mailbox on the home screen:
 * a real install button on Android, step-by-step instructions on iPhone.
 */
export function InstallPrompt() {
  const brand = useBrand();
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [guide, setGuide] = useState(false);

  useEffect(() => {
    if (isStandalone() || dismissedRecently() || window.innerWidth >= 768) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallEvent);
      setHidden(false);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    if (isIosSafari()) (setIos(true), setHidden(false));
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* fine: it just shows again next time */
    }
    setHidden(true);
  };

  const install = async () => {
    if (ios) return setGuide(true);
    if (!installEvent) return;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === "accepted") setHidden(true);
    setInstallEvent(null);
  };

  if (hidden) return null;
  return (
    <>
      <div className="flex items-center gap-3 border-b border-line bg-accent-softer px-3 py-2 md:hidden">
        <img src="/api/brand/icons/icon-192.png" alt="" className="size-8 shrink-0 rounded-[8px]" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-medium">Get the {brand.productName} app</p>
          <p className="truncate text-xs text-fg-muted">Open your mailbox from your home screen</p>
        </div>
        <Button size="sm" variant="primary" onClick={install}>
          Install
        </Button>
        <button onClick={dismiss} aria-label="Not now" className="rounded p-1 text-fg-muted hover:bg-muted">
          <X className="size-4" />
        </button>
      </div>
      <Modal open={guide} onClose={() => setGuide(false)} title={`Add ${brand.productName} to your home screen`} width={380}>
        <ol className="space-y-4 text-[14px]">
          <li className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <Share className="size-4" />
            </span>
            <span>
              Tap the <b>Share</b> button in Safari's toolbar.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <SquarePlus className="size-4" />
            </span>
            <span>
              Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.
            </span>
          </li>
          <li className="text-xs text-fg-muted">
            Open it from the new icon and sign in once. It opens full screen, like an app, and can show new-mail notifications.
          </li>
        </ol>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => (setGuide(false), dismiss())}>
            Got it
          </Button>
        </div>
      </Modal>
    </>
  );
}
