import { AlertCircle, Download, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, X } from "lucide-react";
import type { AttachmentInfo } from "@shared/types";
import { fileSize } from "@/lib/format";
import { cx } from "../ui/primitives";

function iconFor(type: string, name: string) {
  if (type.startsWith("image/")) return FileImage;
  if (type.startsWith("video/")) return FileVideo;
  if (type.startsWith("audio/")) return FileAudio;
  if (/pdf|word|document|text/.test(type) || /\.(pdf|docx?|txt|md|rtf)$/i.test(name)) return FileText;
  if (/sheet|excel|csv/.test(type) || /\.(xlsx?|csv)$/i.test(name)) return FileSpreadsheet;
  if (/zip|compressed|tar|rar|7z/.test(type)) return FileArchive;
  return File;
}

export function AttachmentChip({
  attachment,
  onRemove,
  progress,
  error,
  onPreview,
}: {
  attachment: AttachmentInfo;
  onRemove?: () => void;
  progress?: number;
  error?: string;
  onPreview?: () => void;
}) {
  const Icon = error ? AlertCircle : iconFor(attachment.contentType, attachment.filename);
  const uploaded = progress === undefined && !error && !attachment.id.startsWith("tmp-");
  const isImage = attachment.contentType.startsWith("image/") && uploaded;
  return (
    <div
      className={cx(
        "group relative flex w-56 items-center gap-2.5 overflow-hidden rounded-ui border bg-surface p-2 transition-colors",
        error ? "border-danger/40" : "border-line hover:border-line-strong",
      )}
      title={error ?? attachment.filename}
    >
      <button
        type="button"
        onClick={onPreview}
        disabled={!onPreview}
        className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-ui-sm bg-muted text-fg-muted"
      >
        {isImage ? <img src={`/api/attachments/${attachment.id}`} alt="" className="size-full object-cover" loading="lazy" /> : <Icon className={cx("size-4", error && "text-danger")} />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{attachment.filename}</p>
        <p className={cx("truncate text-[11px]", error ? "text-danger" : "text-fg-muted")}>
          {error ? error : progress !== undefined ? `Uploading ${progress}%` : fileSize(attachment.size)}
        </p>
      </div>
      {uploaded && !onRemove && (
        <a
          href={`/api/attachments/${attachment.id}?download=1`}
          className="rounded p-1 text-fg-faint opacity-0 transition group-hover:opacity-100 hover:bg-muted hover:text-fg focus:opacity-100"
          aria-label={`Download ${attachment.filename}`}
        >
          <Download className="size-4" />
        </a>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded p-1 text-fg-faint hover:bg-muted hover:text-fg" aria-label={`Remove ${attachment.filename}`}>
          <X className="size-3.5" />
        </button>
      )}
      {progress !== undefined && (
        <span className="absolute bottom-0 left-0 h-0.5 bg-accent transition-[width]" style={{ width: `${progress}%` }} />
      )}
    </div>
  );
}
