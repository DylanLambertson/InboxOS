import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Minus, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AVATAR_MAX_BYTES } from "@shared/profile";
import type { Me } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { Avatar } from "@/components/ui/Avatar";
import { Button, IconButton } from "@/components/ui/primitives";
import { Modal, useConfirm } from "@/components/ui/overlay";

const VIEW = 240;
const OUT = 512;
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];

interface Source {
  url: string;
  type: string;
  img: HTMLImageElement;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image couldn't be opened."));
    img.src = url;
  });
}

/** Square crop with drag-to-move and zoom; renders a 512×512 image. */
function Cropper({ src, onCancel, onDone }: { src: Source; onCancel: () => void; onDone: (blob: Blob) => Promise<void> }) {
  const { img } = src;
  const base = VIEW / Math.min(img.naturalWidth, img.naturalHeight);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const scale = base * zoom;
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  // Keep the image covering the whole square.
  const clamp = (p: { x: number; y: number }, s = scale) => {
    const mx = (img.naturalWidth * s - VIEW) / 2;
    const my = (img.naturalHeight * s - VIEW) / 2;
    return { x: Math.max(-mx, Math.min(mx, p.x)), y: Math.max(-my, Math.min(my, p.y)) };
  };
  const setZoomClamped = (z: number) => {
    const next = Math.max(1, Math.min(4, z));
    setZoom(next);
    setPos((p) => clamp(p, base * next));
  };

  const onDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }));
  };

  const finish = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = OUT;
    const ctx = canvas.getContext("2d")!;
    const left = VIEW / 2 - w / 2 + pos.x;
    const top = VIEW / 2 - h / 2 + pos.y;
    const size = VIEW / scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, -left / scale, -top / scale, size, size, 0, 0, OUT, OUT);
    // Keep transparency for PNG and WebP; photos compress better as JPEG.
    const type = src.type === "image/png" || src.type === "image/webp" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.9));
    if (!blob) return toast.error("Couldn't prepare the photo. Try another image.");
    setBusy(true);
    try {
      await onDone(blob);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div
        className="relative mx-auto cursor-grab touch-none overflow-hidden rounded-ui bg-muted active:cursor-grabbing"
        style={{ width: VIEW, height: VIEW }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onWheel={(e) => setZoomClamped(zoom - e.deltaY * 0.002)}
        tabIndex={0}
        aria-label="Photo crop area. Use arrow keys to move and + or - to zoom."
        onKeyDown={(e) => {
          const step = e.shiftKey ? 20 : 5;
          if (e.key === "ArrowLeft") setPos((p) => clamp({ ...p, x: p.x + step }));
          else if (e.key === "ArrowRight") setPos((p) => clamp({ ...p, x: p.x - step }));
          else if (e.key === "ArrowUp") setPos((p) => clamp({ ...p, y: p.y + step }));
          else if (e.key === "ArrowDown") setPos((p) => clamp({ ...p, y: p.y - step }));
          else if (e.key === "+" || e.key === "=") setZoomClamped(zoom + 0.1);
          else if (e.key === "-") setZoomClamped(zoom - 0.1);
          else return;
          e.preventDefault();
        }}
      >
        <img
          src={src.url}
          alt=""
          draggable={false}
          className="pointer-events-none absolute max-w-none select-none"
          style={{ width: w, height: h, left: VIEW / 2 - w / 2 + pos.x, top: VIEW / 2 - h / 2 + pos.y }}
        />
        {/* The circle teammates will see. */}
        <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgb(0_0_0/0.45)]" />
      </div>
      <div className="mx-auto flex max-w-[260px] items-center gap-2">
        <IconButton size="sm" label="Zoom out" onClick={() => setZoomClamped(zoom - 0.2)}>
          <Minus className="size-3.5" />
        </IconButton>
        <input
          type="range"
          aria-label="Zoom"
          min={1}
          max={4}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoomClamped(Number(e.target.value))}
          className="flex-1 accent-[var(--accent)]"
        />
        <IconButton size="sm" label="Zoom in" onClick={() => setZoomClamped(zoom + 0.2)}>
          <Plus className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} onClick={finish}>
          Use photo
        </Button>
      </div>
    </div>
  );
}

/** Profile photo: upload (with a square crop), replace or remove. */
export function AvatarEditor({ me, name }: { me: Me; name: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState<Source | null>(null);
  const [removing, setRemoving] = useState(false);
  useEffect(() => () => void (src && URL.revokeObjectURL(src.url)), [src]);

  const refreshEverywhere = (updated: Me) => {
    qc.setQueryData(["me"], updated);
    // Teammate lists cache avatar URLs.
    for (const key of ["people", "members", "conversation", "messages"]) qc.invalidateQueries({ queryKey: [key] });
  };

  const pick = async (file: File) => {
    if (!ACCEPT.includes(file.type)) return toast.error("Use a PNG, JPEG, WebP or GIF image.");
    if (file.size > 20 * 1024 * 1024) return toast.error("That image is too large. Pick one under 20 MB.");
    const url = URL.createObjectURL(file);
    try {
      setSrc({ url, type: file.type, img: await loadImage(url) });
    } catch (e) {
      URL.revokeObjectURL(url);
      toast.error(errorMessage(e));
    }
  };

  const upload = async (blob: Blob) => {
    if (blob.size > AVATAR_MAX_BYTES) return void toast.error("That photo is still over 2 MB after cropping. Try a smaller image.");
    const form = new FormData();
    form.append("file", new File([blob], blob.type === "image/png" ? "avatar.png" : "avatar.jpg", { type: blob.type }));
    try {
      refreshEverywhere(await api.post<Me>("me/avatar", form));
      setSrc(null);
      toast.success("Photo updated");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: "Remove your photo?", body: "Teammates will see your initials instead.", confirmLabel: "Remove" }))) return;
    setRemoving(true);
    try {
      refreshEverywhere(await api.del<Me>("me/avatar"));
      toast.success("Photo removed");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 sm:items-start">
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="group relative rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label={me.avatarUrl ? "Change photo" : "Add a photo"}
      >
        <Avatar name={name || me.name} email={me.email} color={me.avatarColor} src={me.avatarUrl} size={96} />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Camera className="size-5" />
        </span>
      </button>
      <div className="flex gap-1.5">
        <Button size="sm" onClick={() => input.current?.click()}>
          {me.avatarUrl ? "Change" : "Add photo"}
        </Button>
        {me.avatarUrl && (
          <IconButton size="sm" label="Remove photo" onClick={remove} disabled={removing}>
            <Trash2 className="size-3.5" />
          </IconButton>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(",")}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void pick(f);
        }}
      />
      <Modal open={!!src} onClose={() => setSrc(null)} title="Crop your photo" description="Drag to position, zoom to fit. Teammates see it as a circle." width={360}>
        {src && <Cropper src={src} onCancel={() => setSrc(null)} onDone={upload} />}
      </Modal>
    </div>
  );
}
