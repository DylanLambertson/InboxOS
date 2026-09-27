import { useCallback, useState } from "react";
import DOMPurify from "dompurify";
import { ShieldAlert, ShieldX } from "lucide-react";
import type { DlpFinding } from "@shared/outbound";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/overlay";

/**
 * Shows what the data-loss check found before a send. Returns true when the sender
 * chooses "Send anyway" — offered only when nothing found is set to block.
 */
export function useDlpDialog() {
  const [state, setState] = useState<{ findings: DlpFinding[]; resolve: (ok: boolean) => void } | null>(null);
  const ask = useCallback((findings: DlpFinding[]) => new Promise<boolean>((resolve) => setState({ findings, resolve })), []);
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  const blocked = !!state?.findings.some((f) => f.action === "block");

  const dialog = (
    <Modal
      open={!!state}
      onClose={() => close(false)}
      width={460}
      title={blocked ? "This message can't be sent" : "Check before sending"}
      description={
        blocked
          ? "Your organization doesn't allow sending this kind of information by email. Remove it, then try again."
          : "This message looks like it contains sensitive information."
      }
      footer={
        <>
          <Button variant={blocked ? "primary" : "secondary"} onClick={() => close(false)}>
            {blocked ? "Edit message" : "Go back"}
          </Button>
          {!blocked && (
            <Button variant="danger" onClick={() => close(true)}>
              Send anyway
            </Button>
          )}
        </>
      }
    >
      <ul className="space-y-1.5">
        {state?.findings.map((f, i) => (
          <li key={i} className="flex items-center gap-2 text-[13px]">
            {f.action === "block" ? <ShieldX className="size-4 shrink-0 text-danger" /> : <ShieldAlert className="size-4 shrink-0 text-warning" />}
            <span>{f.label}</span>
            {f.action === "block" && <span className="ml-auto text-xs font-medium text-danger">Blocked</span>}
          </li>
        ))}
      </ul>
    </Modal>
  );
  return { ask, dialog };
}

/** Read-only company signature shown under the editor when admins enforce it. */
export function EnforcedSignature({ html }: { html: string }) {
  if (!html) return null;
  return (
    <div className="mt-3 border-t border-dashed border-line pt-2" title="Your organization adds this signature when the message is sent.">
      <p className="mb-1 text-[11px] font-medium tracking-wide text-fg-faint uppercase">Company signature · added when sent</p>
      <div className="rte pointer-events-none text-fg-muted select-none" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
    </div>
  );
}
