import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor as TipTap } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { Placeholder } from "@tiptap/extensions";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Palette,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
} from "lucide-react";
import { cx, IconButton } from "../ui/primitives";
import { Menu } from "../ui/overlay";

const TEXT_COLORS = ["#111827", "#6b7280", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0284c7", "#4f46e5", "#9333ea", "#db2777"];

export function useMailEditor(opts: { content: string; placeholder?: string; onUpdate?: (html: string) => void; onPasteImage?: (f: File) => void; autofocus?: boolean }) {
  const onUpdate = useRef(opts.onUpdate);
  onUpdate.current = opts.onUpdate;
  const onPasteImage = useRef(opts.onPasteImage);
  onPasteImage.current = opts.onPasteImage;

  return useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
      TextStyle,
      Color,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image.configure({ inline: true, allowBase64: false }),
      Placeholder.configure({ placeholder: opts.placeholder ?? "Write your message…" }),
    ],
    content: opts.content,
    autofocus: opts.autofocus ? "start" : false,
    editorProps: {
      attributes: { class: "rte", spellcheck: "true" },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
        if (files.length && onPasteImage.current) {
          files.forEach((f) => onPasteImage.current?.(f));
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
        if (files.length && onPasteImage.current && (event as DragEvent).altKey) {
          files.forEach((f) => onPasteImage.current?.(f));
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => onUpdate.current?.(editor.getHTML()),
  });
}

function Sep() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-line" />;
}

export function EditorToolbar({ editor, onInsertImage, className }: { editor: TipTap | null; onInsertImage?: () => void; className?: string }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            h1: e.isActive("heading", { level: 1 }),
            h2: e.isActive("heading", { level: 2 }),
            bullet: e.isActive("bulletList"),
            ordered: e.isActive("orderedList"),
            quote: e.isActive("blockquote"),
            code: e.isActive("code"),
            link: e.isActive("link"),
            left: e.isActive({ textAlign: "left" }),
            center: e.isActive({ textAlign: "center" }),
            right: e.isActive({ textAlign: "right" }),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });
  const [linkOpen, setLinkOpen] = useState(false);
  if (!editor || !state) return null;
  const run = (fn: (c: ReturnType<TipTap["chain"]>) => ReturnType<TipTap["chain"]>) => fn(editor.chain().focus()).run();

  return (
    <div className={cx("relative flex flex-wrap items-center gap-0.5", className)}>
      <IconButton size="sm" label="Undo" shortcut="⌘Z" disabled={!state.canUndo} onClick={() => run((c) => c.undo())}>
        <Undo2 className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Redo" shortcut="⌘⇧Z" disabled={!state.canRedo} onClick={() => run((c) => c.redo())}>
        <Redo2 className="size-4" />
      </IconButton>
      <Sep />
      <IconButton size="sm" label="Bold" shortcut="⌘B" active={state.bold} onClick={() => run((c) => c.toggleBold())}>
        <Bold className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Italic" shortcut="⌘I" active={state.italic} onClick={() => run((c) => c.toggleItalic())}>
        <Italic className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Underline" shortcut="⌘U" active={state.underline} onClick={() => run((c) => c.toggleUnderline())}>
        <Underline className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Strikethrough" active={state.strike} onClick={() => run((c) => c.toggleStrike())}>
        <Strikethrough className="size-4" />
      </IconButton>
      <Menu
        width={188}
        items={[
          ...TEXT_COLORS.map((col) => ({
            label: <span className="flex items-center gap-2"><span className="size-3.5 rounded-full" style={{ background: col }} />{col}</span>,
            onSelect: () => run((c) => c.setColor(col)),
          })),
          { separator: true, label: "" },
          { label: "Default color", onSelect: () => run((c) => c.unsetColor()) },
        ]}
        trigger={(p) => (
          <IconButton size="sm" label="Text color" {...p}>
            <Palette className="size-4" />
          </IconButton>
        )}
      />
      <Sep />
      <IconButton size="sm" label="Heading" active={state.h1} onClick={() => run((c) => c.toggleHeading({ level: 1 }))}>
        <Heading1 className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Subheading" active={state.h2} onClick={() => run((c) => c.toggleHeading({ level: 2 }))}>
        <Heading2 className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Bulleted list" shortcut="⌘⇧8" active={state.bullet} onClick={() => run((c) => c.toggleBulletList())}>
        <List className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Numbered list" shortcut="⌘⇧7" active={state.ordered} onClick={() => run((c) => c.toggleOrderedList())}>
        <ListOrdered className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Quote" active={state.quote} onClick={() => run((c) => c.toggleBlockquote())}>
        <Quote className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Inline code" active={state.code} onClick={() => run((c) => c.toggleCode())}>
        <Code className="size-4" />
      </IconButton>
      <Sep />
      <IconButton size="sm" label="Align left" active={state.left} onClick={() => run((c) => c.setTextAlign("left"))}>
        <AlignLeft className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Align center" active={state.center} onClick={() => run((c) => c.setTextAlign("center"))}>
        <AlignCenter className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Align right" active={state.right} onClick={() => run((c) => c.setTextAlign("right"))}>
        <AlignRight className="size-4" />
      </IconButton>
      <Sep />
      <IconButton size="sm" label="Link" shortcut="⌘K" active={state.link} onClick={() => setLinkOpen((o) => !o)}>
        <Link2 className="size-4" />
      </IconButton>
      {onInsertImage && (
        <IconButton size="sm" label="Insert image" onClick={onInsertImage}>
          <ImagePlus className="size-4" />
        </IconButton>
      )}
      <IconButton size="sm" label="Divider" onClick={() => run((c) => c.setHorizontalRule())}>
        <Minus className="size-4" />
      </IconButton>
      <IconButton size="sm" label="Clear formatting" onClick={() => run((c) => c.unsetAllMarks().clearNodes())}>
        <RemoveFormatting className="size-4" />
      </IconButton>
      {linkOpen && <LinkPopover editor={editor} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

function LinkPopover({ editor, onClose }: { editor: TipTap; onClose: () => void }) {
  const [url, setUrl] = useState<string>(editor.getAttributes("link").href ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const apply = () => {
    const v = url.trim();
    if (!v) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else {
      const href = /^(https?:|mailto:|tel:)/i.test(v) ? v : /@/.test(v) && !v.includes("/") ? `mailto:${v}` : `https://${v}`;
      if (editor.state.selection.empty && !editor.isActive("link")) {
        editor.chain().focus().insertContent(`<a href="${href.replace(/"/g, "&quot;")}">${v.replace(/</g, "&lt;")}</a> `).run();
      } else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    onClose();
  };
  return (
    <div className="animate-in absolute top-full left-0 z-30 mt-1 flex w-80 items-center gap-1.5 rounded-ui border border-line bg-raised p-1.5 shadow-ui-lg">
      <input
        ref={input}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.preventDefault(), apply());
          if (e.key === "Escape") (e.stopPropagation(), onClose());
        }}
        placeholder="Paste a link or email address"
        className="h-8 min-w-0 flex-1 rounded-ui-sm bg-subtle px-2 text-[13px] outline-none"
      />
      <button onClick={apply} className="h-8 rounded-ui-sm bg-accent px-3 text-[13px] font-medium text-accent-fg">
        Apply
      </button>
    </div>
  );
}

export function RichTextField({ value, onChange, placeholder, minHeight = 140 }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number }) {
  const editor = useMailEditor({ content: value, placeholder, onUpdate: onChange });
  return (
    <div className="overflow-hidden rounded-ui border border-line bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
      <EditorToolbar editor={editor} className="border-b border-line bg-subtle px-1.5 py-1" />
      <div className="cursor-text px-3 py-2.5" style={{ minHeight }} onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
