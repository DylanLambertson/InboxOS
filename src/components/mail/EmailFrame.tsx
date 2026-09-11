import { useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentInfo } from "@shared/types";
import { sanitizeEmail, textToHtml } from "@/lib/sanitize";
import { cx } from "../ui/primitives";

/** True when the app is currently rendering dark (explicit choice or system preference). */
function useIsDark(): boolean {
  const read = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(read());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    mq.addEventListener("change", update);
    return () => (mo.disconnect(), mq.removeEventListener("change", update));
  }, []);
  return dark;
}

/**
 * Renders email HTML in a sandboxed iframe: no scripts, no forms, links open in new tabs.
 * `allow-same-origin` (without `allow-scripts`) lets us size the frame and load inline
 * attachments with the user's session; the app's CSP blocks any script as a second line of defence.
 */
export function EmailFrame({
  html,
  text,
  attachments,
  allowRemote,
  onBlocked,
  maxHeight,
  attachmentBase,
}: {
  html?: string | null;
  text?: string;
  attachments: AttachmentInfo[];
  allowRemote: boolean;
  onBlocked?: (count: number) => void;
  maxHeight?: number;
  /** Where inline images are served from (admins use the traffic endpoint). */
  attachmentBase?: string;
}) {
  const dark = useIsDark();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  // Plain-text mail has no design of its own, so it follows the app theme instead of sitting on a white card.
  const themed = !html && dark;

  const { doc, blocked } = useMemo(() => {
    const source = html ?? textToHtml(text ?? "");
    const { html: clean, blockedImages } = sanitizeEmail(source, { attachments, allowRemote, attachmentBase });
    const base = `<base target="_blank"><meta name="color-scheme" content="${themed ? "dark" : "light"}"><style>
      html,body{margin:0;padding:0;background:transparent}
      body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:${themed ? "#e4e4e7" : "#1f2328"};word-wrap:break-word;overflow-wrap:anywhere;padding:${dark && !themed ? "14px 16px" : "2px"}}
      img{max-width:100%;height:auto}
      table{max-width:100%}
      pre{white-space:pre-wrap}
      blockquote{margin:0 0 0 .8ex;border-left:2px solid ${themed ? "#3f3f46" : "#d0d7de"};padding-left:1ex;color:${themed ? "#a1a1aa" : "#57606a"}}
      a{color:${themed ? "#8ab4ff" : "#2563eb"}}
      [data-blocked-src]{display:inline-block;min-width:16px;min-height:16px;background:repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6 6px,#e5e7eb 6px,#e5e7eb 12px);border-radius:3px}
    </style>`;
    const withHead = /<head[^>]*>/i.test(clean) ? clean.replace(/<head([^>]*)>/i, `<head$1>${base}`) : `<!doctype html><html><head>${base}</head><body>${clean}</body></html>`;
    return { doc: withHead, blocked: blockedImages };
  }, [html, text, attachments, allowRemote, dark, themed, attachmentBase]);

  useEffect(() => onBlocked?.(blocked), [blocked, onBlocked]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const d = frame.contentDocument;
      if (!d?.body) return;
      const h = Math.max(d.documentElement.scrollHeight, d.body.scrollHeight);
      setHeight(maxHeight ? Math.min(h + 4, maxHeight) : h + 4);
    };
    const onLoad = () => {
      measure();
      const d = frame.contentDocument;
      if (d?.body) {
        ro = new ResizeObserver(measure);
        ro.observe(d.body);
        d.querySelectorAll("img").forEach((img) => img.addEventListener("load", measure));
      }
    };
    frame.addEventListener("load", onLoad);
    if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.body?.childElementCount) onLoad();
    return () => {
      frame.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [doc, maxHeight]);

  return (
    <iframe
      ref={ref}
      title="Email content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      className={cx("block w-full rounded-ui-sm border-0", themed ? "bg-transparent" : "bg-white")}
      style={{ height, overflow: maxHeight ? "auto" : "hidden" }}
    />
  );
}
