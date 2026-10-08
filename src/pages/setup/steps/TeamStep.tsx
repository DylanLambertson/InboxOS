import { useMemo, useState } from "react";
import { CheckCircle2, Mail, X } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useRefreshSetup } from "@/lib/setup";
import { CopyField } from "@/components/setup/StatusBadges";
import { Badge, Checkbox, Field, Select, Textarea } from "@/components/ui/primitives";
import { DoneNote, Panel, StepFrame, type StepProps } from "../StepFrame";

type InviteRole = "member" | "manager" | "admin";
const ROLES: { id: InviteRole; label: string }[] = [
  { id: "member", label: "Member" },
  { id: "manager", label: "Manager (view admin)" },
  { id: "admin", label: "Admin" },
];

/** Pull email addresses out of whatever was pasted (lists, "Name <a@b>", commas, new lines). */
export function parseEmails(text: string): string[] {
  const found = text.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
  return [...new Set(found)];
}

interface Result {
  email: string;
  status: "invited" | "exists";
  inviteUrl?: string;
  emailed?: boolean;
  mailbox?: string;
}

export function TeamStep({ setup, next, skip, back }: StepProps) {
  const [text, setText] = useState("");
  const [roles, setRoles] = useState<Record<string, InviteRole>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const shared = setup.mailboxes.filter((m) => m.type === "shared");
  const [access, setAccess] = useState<Set<string>>(() => new Set(shared.map((m) => m.id)));
  const canEmail = setup.provider.apiKey.configured && !!setup.primaryDomain;
  const [sendEmail, setSendEmail] = useState(canEmail);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const refresh = useRefreshSetup();
  const emails = useMemo(() => parseEmails(text).filter((e) => e !== setup.me.email && !removed.has(e)), [text, removed, setup.me.email]);

  const invite = async () => {
    if (!emails.length) return next();
    setBusy(true);
    try {
      const r = await api.post<{ results: Result[] }>("admin/setup/invites", {
        invites: emails.map((email) => ({ email, role: roles[email] ?? "member" })),
        sharedMailboxIds: [...access],
        sendEmail: sendEmail && canEmail,
      });
      setResults(r.results);
      setText("");
      setRemoved(new Set());
      const n = r.results.filter((x) => x.status === "invited").length;
      toast.success(n ? `Invited ${n} ${n === 1 ? "person" : "people"}` : "Everyone listed already has an account");
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title="Invite your team"
      description="Paste addresses and pick what each person can do. People invited at an address on your domain get it as their own inbox."
      onBack={back}
      onSkip={results ? undefined : skip}
      onContinue={results && !emails.length ? next : invite}
      continueLoading={busy}
      continueLabel={emails.length ? `Invite ${emails.length} ${emails.length === 1 ? "person" : "people"}` : "Continue"}
      continueDisabled={!emails.length && !results && setup.steps.team !== "done"}
    >
      {results && (
        <DoneNote>
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="font-medium">Invitations ready</div>
            {results.map((r) => (
              <div key={r.email} className="space-y-1 text-fg">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-medium">{r.email}</span>
                  {r.status === "exists" ? <Badge>Already has an account</Badge> : r.emailed ? <Badge tone="success">Email sent</Badge> : <Badge tone="warning">Share the link yourself</Badge>}
                  {r.mailbox && <Badge tone="accent">Inbox {r.mailbox}</Badge>}
                </div>
                {r.inviteUrl && !r.emailed && <CopyField value={r.inviteUrl} />}
              </div>
            ))}
          </div>
        </DoneNote>
      )}

      <Panel>
        <Field label="Email addresses" htmlFor="invite-emails" hint="Separate with commas, spaces or new lines. Paste straight from a spreadsheet if you like.">
          <Textarea id="invite-emails" value={text} onChange={(e) => setText(e.target.value)} placeholder={`alex@${setup.primaryDomain || "example.com"}, sam@${setup.primaryDomain || "example.com"}`} className="min-h-24" />
        </Field>
        {emails.length > 0 && (
          <ul className="mt-4 divide-y divide-line rounded-ui border border-line">
            {emails.map((e) => (
              <li key={e} className="flex items-center gap-3 px-3 py-2">
                <Mail className="size-4 shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{e}</span>
                <Select aria-label={`Role for ${e}`} value={roles[e] ?? "member"} onChange={(ev) => setRoles((r) => ({ ...r, [e]: ev.target.value as InviteRole }))} className="h-8 w-48 text-[13px]">
                  {ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </Select>
                <button type="button" aria-label={`Remove ${e}`} onClick={() => setRemoved((s) => new Set(s).add(e))} className="rounded p-1 text-fg-muted hover:bg-muted hover:text-fg">
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {shared.length > 0 && (
        <Panel title="Shared inboxes" description="Everyone invited here can read and reply in these.">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {shared.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-[13px]">
                <Checkbox
                  checked={access.has(m.id)}
                  onChange={(v) =>
                    setAccess((s) => {
                      const n = new Set(s);
                      if (v) n.add(m.id);
                      else n.delete(m.id);
                      return n;
                    })
                  }
                  label={m.address}
                />
                {m.address}
              </label>
            ))}
          </div>
        </Panel>
      )}

      <label className="flex items-start gap-2 text-[13px] text-fg-muted">
        <Checkbox checked={sendEmail && canEmail} onChange={setSendEmail} label="Email the invitations" className={canEmail ? "mt-0.5" : "mt-0.5 opacity-50"} />
        <span>
          Email the invitations{" "}
          {!canEmail && <span className="text-fg-faint">(available once the email provider and a domain are set up; until then you'll get links to share)</span>}
        </span>
      </label>
    </StepFrame>
  );
}
