import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import {
  DLP_RULES,
  renderSignature,
  SIGNATURE_VARS,
  type DlpAction,
  type DlpScope,
  type OutboundPolicy,
  type SignatureMode,
} from "@shared/outbound";
import { api, errorMessage } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { useCanManage, useMe } from "@/lib/queries";
import { EmailFrame } from "@/components/mail/EmailFrame";
import { Tabs } from "@/components/ui/overlay";
import { Button, Field, IconButton, LoadError, PageHeader, Section, Select, Spinner, Switch, Textarea } from "@/components/ui/primitives";

interface MailboxOption {
  id: string;
  address: string;
  displayName: string;
}

type Tab = "signature" | "disclaimer" | "dlp";

const MODES: { value: SignatureMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Everyone writes their own signature." },
  { value: "suggest", label: "Suggest", hint: "New and empty signatures start from the company template; people can edit theirs." },
  { value: "enforce", label: "Enforce", hint: "The company signature is added to every message from the app and can't be edited by users." },
];

function Preview({ html, label }: { html: string; label: string }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-fg-muted">{label}</p>
      <div className="rounded-ui border border-line bg-white">
        {html.trim() ? <EmailFrame html={html} attachments={[]} allowRemote maxHeight={260} /> : <p className="p-4 text-[13px] text-fg-faint">Nothing to show.</p>}
      </div>
    </div>
  );
}

function TemplateEditor({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (v: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    onChange(`${value.slice(0, at)}{{${v}}}${value.slice(el?.selectionEnd ?? at)}`);
    requestAnimationFrame(() => el?.focus());
  };
  return (
    <div className="space-y-2">
      <Textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} rows={6} disabled={disabled} className="font-mono text-xs" spellCheck={false} />
      {!disabled && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          Insert:
          {SIGNATURE_VARS.map((v) => (
            <button key={v} type="button" onClick={() => insert(v)} className="rounded bg-muted px-1.5 py-0.5 font-mono hover:bg-line hover:text-fg">
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RuleRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </div>
  );
}

export function AdminOutboundPolicy() {
  const { data, error, refetch } = useQuery({
    queryKey: ["admin-outbound"],
    queryFn: () => api.get<{ policy: OutboundPolicy; mailboxes: MailboxOption[] }>("admin/outbound"),
  });
  const { data: me } = useMe();
  const brand = useBrand();
  const canManage = useCanManage();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("signature");
  const [p, setP] = useState<OutboundPolicy | null>(null);
  const [keywords, setKeywords] = useState("");
  const [previewBox, setPreviewBox] = useState("");
  const [addBox, setAddBox] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) {
      setP(data.policy);
      setKeywords(data.policy.dlp.keywords.join("\n"));
    }
  }, [data]);

  const mailboxes = data?.mailboxes ?? [];
  const box = mailboxes.find((m) => m.id === previewBox);
  const previewSig = useMemo(() => {
    if (!p) return "";
    const template = (box && p.signature.mailboxTemplates[box.id]) || p.signature.template;
    // Preview with the admin's own profile; values are escaped exactly as when sending.
    return renderSignature(template, {
      name: me?.name ?? "",
      title: me?.jobTitle ?? "",
      email: box?.address ?? me?.email ?? "",
      phone: me?.phone ?? "",
      mailbox: box?.displayName || box?.address || "",
      company: brand.companyName,
    });
  }, [p, box, me, brand.companyName]);

  if (error && !data) return <LoadError error={error} onRetry={() => refetch()} />;
  if (!p) return <Spinner />;
  const ro = !canManage;
  const setSig = (patch: Partial<OutboundPolicy["signature"]>) => setP((x) => (x ? { ...x, signature: { ...x.signature, ...patch } } : x));
  const setDisc = (patch: Partial<OutboundPolicy["disclaimer"]>) => setP((x) => (x ? { ...x, disclaimer: { ...x.disclaimer, ...patch } } : x));
  const setRule = (id: keyof OutboundPolicy["dlp"]["rules"], patch: { action?: DlpAction; scope?: DlpScope }) =>
    setP((x) => (x ? { ...x, dlp: { ...x.dlp, rules: { ...x.dlp.rules, [id]: { ...x.dlp.rules[id], ...patch } } } } : x));
  const setOverride = (id: string, html: string | null) =>
    setSig({ mailboxTemplates: Object.fromEntries(Object.entries({ ...p.signature.mailboxTemplates, [id]: html }).filter(([, v]) => v !== null)) as Record<string, string> });

  const save = async () => {
    setBusy(true);
    const next: OutboundPolicy = { ...p, dlp: { ...p.dlp, keywords: keywords.split("\n").map((k) => k.trim()).filter(Boolean) } };
    try {
      const res = await api.put<{ policy: OutboundPolicy }>("admin/outbound", next as unknown as Record<string, unknown>);
      qc.setQueryData(["admin-outbound"], { policy: res.policy, mailboxes });
      qc.invalidateQueries({ queryKey: ["org-signature"] });
      toast.success("Outbound policy saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const disclaimerPreview = p.disclaimer.text.trim()
    ? `<p>Hi Sam, thanks for the call today.</p><div style="margin-top:24px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:11px;line-height:1.5;color:#6b7280">${p.disclaimer.text
        .trim()
        .replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
        .replace(/\n/g, "<br>")}</div>`
    : "";
  const unused = mailboxes.filter((m) => !(m.id in p.signature.mailboxTemplates));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Signatures & DLP"
        description="Company signatures, a legal disclaimer, and checks that stop sensitive data leaving by email. Applies to every send: the app, scheduled mail, the API and MCP."
        actions={canManage ? <Button variant="primary" loading={busy} onClick={save}>Save changes</Button> : undefined}
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "signature", label: "Signature" },
          { value: "disclaimer", label: "Disclaimer" },
          { value: "dlp", label: "Data-loss prevention" },
        ]}
      />

      {tab === "signature" && (
        <>
          <Section title="Company signature" description="One template for everyone, filled in from each person's profile (name, job title, phone).">
            <div className="space-y-5">
              <Field label="Mode" hint={MODES.find((m) => m.value === p.signature.mode)?.hint}>
                <Select value={p.signature.mode} onChange={(e) => setSig({ mode: e.target.value as SignatureMode })} disabled={ro} className="w-48">
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Template (HTML)" hint="Values are escaped, so a name can't inject HTML. Empty lines from blank fields are dropped.">
                <TemplateEditor value={p.signature.template} onChange={(template) => setSig({ template })} disabled={ro} />
              </Field>
              <div className="space-y-2">
                <Field label="Preview as">
                  <Select value={previewBox} onChange={(e) => setPreviewBox(e.target.value)} className="w-72">
                    <option value="">You, no mailbox</option>
                    {mailboxes.map((m) => (
                      <option key={m.id} value={m.id}>
                        You, sending from {m.address}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Preview html={previewSig} label="Preview" />
              </div>
            </div>
          </Section>

          <Section title="Per-mailbox templates" description="A shared mailbox (support@, billing@) can use its own template instead of the company one.">
            <div className="space-y-5">
              {Object.entries(p.signature.mailboxTemplates).map(([id, html]) => {
                const m = mailboxes.find((x) => x.id === id);
                return (
                  <div key={id} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[13px] font-medium">{m?.address ?? "Deleted mailbox"}</p>
                      {!ro && (
                        <IconButton label="Remove override" size="sm" onClick={() => setOverride(id, null)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </div>
                    <TemplateEditor value={html} onChange={(v) => setOverride(id, v)} disabled={ro} />
                  </div>
                );
              })}
              {!Object.keys(p.signature.mailboxTemplates).length && <p className="text-[13px] text-fg-muted">No mailbox overrides.</p>}
              {!ro && unused.length > 0 && (
                <div className="flex items-center gap-2">
                  <Select value={addBox} onChange={(e) => setAddBox(e.target.value)} className="w-72">
                    <option value="">Choose a mailbox…</option>
                    {unused.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.address}
                      </option>
                    ))}
                  </Select>
                  <Button variant="secondary" icon={<Plus className="size-4" />} disabled={!addBox} onClick={() => (setOverride(addBox, p.signature.template), setAddBox(""))}>
                    Add override
                  </Button>
                </div>
              )}
            </div>
          </Section>
        </>
      )}

      {tab === "disclaimer" && (
        <Section title="Legal disclaimer" description="Added in small grey text at the bottom of outgoing email, by the server, so it can't be removed. Replies that already quote it don't get a second copy.">
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-6">
              <p className="text-[13px] font-medium">Add a disclaimer</p>
              <Switch checked={p.disclaimer.enabled} onChange={(enabled) => setDisc({ enabled })} disabled={ro} label="Add a disclaimer" />
            </div>
            <Field label="Disclaimer text" hint="Plain text. Line breaks are kept.">
              <Textarea
                value={p.disclaimer.text}
                onChange={(e) => setDisc({ text: e.target.value })}
                rows={5}
                maxLength={5000}
                disabled={ro}
                placeholder="This email and any attachments are confidential and intended solely for the addressee…"
              />
            </Field>
            <div className="flex items-center justify-between gap-6">
              <div>
                <p className="text-[13px] font-medium">Only for external recipients</p>
                <p className="mt-0.5 text-xs text-fg-muted">Skip it when everyone is at {[brand.primaryDomain, ...brand.additionalDomains].join(", ")}.</p>
              </div>
              <Switch checked={p.disclaimer.externalOnly} onChange={(externalOnly) => setDisc({ externalOnly })} disabled={ro} label="Only for external recipients" />
            </div>
            <Preview html={disclaimerPreview} label="Preview" />
          </div>
        </Section>
      )}

      {tab === "dlp" && (
        <>
          <Section
            title="Sensitive data checks"
            description="Checked in the subject, body, quoted text and attachment names before anything is sent. Warn asks the sender to confirm; Block refuses to send, from the app, the API and MCP alike. Every warning and block is recorded in the audit log, without the data itself."
          >
            <div className="divide-y divide-line">
              {DLP_RULES.map((r) => (
                <RuleRow key={r.id} title={r.label} description={r.description}>
                  <Select value={p.dlp.rules[r.id].action} onChange={(e) => setRule(r.id, { action: e.target.value as DlpAction })} disabled={ro} className="w-28" aria-label={`${r.label} action`}>
                    <option value="off">Off</option>
                    <option value="warn">Warn</option>
                    <option value="block">Block</option>
                  </Select>
                  <Select
                    value={p.dlp.rules[r.id].scope}
                    onChange={(e) => setRule(r.id, { scope: e.target.value as DlpScope })}
                    disabled={ro || p.dlp.rules[r.id].action === "off"}
                    className="w-44"
                    aria-label={`${r.label} applies to`}
                  >
                    <option value="external">External recipients</option>
                    <option value="all">All recipients</option>
                  </Select>
                </RuleRow>
              ))}
            </div>
          </Section>
          <Section title="Custom keywords" description="One word or phrase per line, matched as whole words and ignoring case. Uses the Custom keywords rule above.">
            <Textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={6} disabled={ro} placeholder={"Project Falcon\nconfidential"} />
          </Section>
        </>
      )}
    </div>
  );
}
