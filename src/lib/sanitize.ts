import DOMPurify from "dompurify";
import type { AttachmentInfo } from "@shared/types";

export interface SanitizeResult {
  html: string;
  blockedImages: number;
}

const REMOTE = /^(https?:)?\/\//i;

/**
 * Sanitize received email HTML for display in a sandboxed iframe.
 * - strips scripts, forms, event handlers, dangerous URLs (DOMPurify)
 * - rewrites cid: references to our attachment URLs
 * - optionally blocks remote images (tracking pixels) until the user allows them
 * - forces links to open in a new tab
 */
export function sanitizeEmail(raw: string, opts: { attachments: AttachmentInfo[]; allowRemote: boolean; attachmentBase?: string }): SanitizeResult {
  let blocked = 0;
  const base = opts.attachmentBase ?? "/api/attachments";
  const cidMap = new Map(opts.attachments.filter((a) => a.contentId).map((a) => [a.contentId!.toLowerCase(), `${base}/${a.id}`]));

  const rewriteUrl = (url: string): string | null => {
    const u = url.trim();
    if (/^cid:/i.test(u)) return cidMap.get(u.slice(4).replace(/^<|>$/g, "").toLowerCase()) ?? "";
    if (REMOTE.test(u) && !opts.allowRemote) {
      blocked++;
      return null;
    }
    return u;
  };

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    }
    for (const attr of ["src", "background", "poster"]) {
      const v = el.getAttribute?.(attr);
      if (v == null) continue;
      const next = rewriteUrl(v);
      if (next === null) {
        el.setAttribute(`data-blocked-${attr}`, v);
        el.removeAttribute(attr);
      } else el.setAttribute(attr, next);
    }
    if (el.hasAttribute?.("srcset") && !opts.allowRemote) el.removeAttribute("srcset");
    const style = el.getAttribute?.("style");
    if (style && /url\s*\(/i.test(style)) {
      el.setAttribute(
        "style",
        style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, q, url) => {
          const next = rewriteUrl(url);
          return next === null ? "none" : `url(${q}${next}${q})`;
        }),
      );
    }
  });

  let html = DOMPurify.sanitize(raw, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ["script", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "base", "meta", "link"],
    FORBID_ATTR: ["action", "formaction"],
    ADD_TAGS: ["style"],
    ADD_ATTR: ["target", "bgcolor", "background", "align", "valign", "cellpadding", "cellspacing", "border"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  DOMPurify.removeHook("afterSanitizeAttributes");

  // <style> blocks may pull remote resources too.
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (block) =>
    block.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, q, url) => {
      const next = rewriteUrl(url);
      return next === null ? "none" : `url(${q}${next}${q})`;
    }).replace(/@import[^;]+;/gi, ""),
  );
  return { html, blockedImages: blocked };
}

export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = esc.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return `<div style="white-space:pre-wrap;font-family:inherit">${linked}</div>`;
}
