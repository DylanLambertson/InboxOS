import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Label } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { Button, cx, Field, Input } from "../ui/primitives";
import { Modal } from "../ui/overlay";

export const LABEL_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#84cc16", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#8b5cf6", "#64748b"];

export function LabelDialog({ open, onClose, mailboxId, label }: { open: boolean; onClose: () => void; mailboxId: string; label?: Label }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (open) {
      setName(label?.name ?? "");
      setColor(label?.color ?? LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)]);
    }
  }, [open, label]);

  const save = async () => {
    setBusy(true);
    try {
      if (label) await api.patch(`labels/${label.id}`, { name, color });
      else await api.post(`mailboxes/${mailboxId}/labels`, { name, color });
      qc.invalidateQueries({ queryKey: ["labels", mailboxId] });
      toast.success(label ? "Label updated" : "Label created");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={label ? "Edit label" : "New label"}
      width={400}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            {label ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save();
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Clients" autoFocus maxLength={60} />
        </Field>
        <Field label="Color">
          <div className="flex flex-wrap gap-2">
            {LABEL_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                className={cx("size-7 rounded-full ring-offset-2 ring-offset-raised transition", color === c && "ring-2 ring-fg")}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>
      </form>
    </Modal>
  );
}
