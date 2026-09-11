import { useEffect, useRef } from "react";
import type { MailboxSummary, Me } from "@shared/types";
import { useBrand } from "./brand";

/**
 * Keeps the tab title showing the unread inbox count ("(3) InboxOS") and, when the
 * user opted in, shows a desktop notification as new mail arrives while the tab is hidden.
 * Driven by the mailbox list, which already polls.
 */
export function useInboxNotifications(me: Me | undefined, boxes: MailboxSummary[]) {
  const brand = useBrand();
  const unread = boxes.reduce((n, b) => n + (b.unread.inbox ?? 0), 0);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    document.title = unread ? `(${unread > 99 ? "99+" : unread}) ${brand.productName}` : brand.productName;
  }, [unread, brand.productName]);
  useEffect(() => () => void (document.title = brand.productName), [brand.productName]);

  useEffect(() => {
    const before = previous.current;
    previous.current = unread;
    // The first load isn't "new" mail.
    if (before === null || unread <= before) return;
    if (!me?.preferences.desktopNotifications || !document.hidden) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const fresh = unread - before;
    try {
      const n = new Notification(fresh === 1 ? "New message" : `${fresh} new messages`, {
        body: `You have ${unread} unread in your inbox${boxes.length > 1 ? "es" : ""}.`,
        icon: brand.logoUrl || "/favicon.ico",
        tag: "inboxos-new-mail",
      });
      n.onclick = () => (window.focus(), n.close());
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }, [unread, me?.preferences.desktopNotifications, boxes.length, brand.logoUrl]);
}
