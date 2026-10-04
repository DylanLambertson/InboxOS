import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, ImageUp, Inbox, KeyRound, MailCheck, Palette, PartyPopper, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import type { Brand } from "@shared/brand";
import { api, errorMessage } from "@/lib/api";
import { regenerateAppIcons } from "@/lib/app-icons";
import { readableOn, useBrand } from "@/lib/brand";
import { useCanManage } from "@/lib/queries";
import { useUnsavedChangesGuard } from "@/lib/unsaved";
import { Button, Field, Input, PageHeader, Section, Textarea } from "@/components/ui/primitives";

/** The fields this page edits. Domains live on the Domains page; the look on Appearance. */
const IDENTITY_KEYS = ["companyName", "productName", "logoUrl", "monogram", "loginHeadline", "loginTagline", "supportEmail", "footerText", "defaultFromName"] as const;
type Identity = Pick<Brand, (typeof IDENTITY_KEYS)[number]>;
const identityOf = (b: Brand): Identity => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, b[k]])) as Identity;

const EMAILS = [
  { name: "invite", label: "Invitation", hint: "Account claim link", icon: UserPlus },
  { name: "welcome", label: "Welcome", hint: "After someone joins", icon: PartyPopper },
  { name: "unreadDigest", label: "Unread digest", hint: "To a personal email", icon: Inbox },
  { name: "verifyPersonalEmail", label: "Confirm personal email", hint: "Before digests start", icon: MailCheck },
  { name: "reset", label: "Password reset", hint: "Forgot password / admin reset", icon: KeyRound },
  { name: "passwordChanged", label: "Password changed", hint: "Security alert", icon: ShieldCheck },
  { name: "twoFactor", label: "Two-factor changed", hint: "Security alert", icon: ShieldCheck },
  { name: "newSignIn", label: "New sign-in", hint: "New device or country", icon: ShieldCheck },
  { name: "passkeyAdded", label: "Passkey added", hint: "Security alert", icon: ShieldCheck },
];

function Mark({ b, accent, size }: { b: Identity; accent: string; size: number }) {
  return b.logoUrl ? (
    <img src={b.logoUrl} alt="" className="shrink-0 rounded-ui-sm object-contain" style={{ width: size, height: size }} />
  ) : (
    <span
      className="flex shrink-0 items-center justify-center rounded-ui-sm font-bold"
      style={{ width: size, height: size, background: accent, color: readableOn(accent), fontSize: size * (b.monogram.length > 2 ? 0.3 : 0.38) }}
    >
      {b.monogram}
    </span>
  );
}

/** How the identity shows up: the app header, the browser tab and the sign-in page. */
function IdentityPreview({ b, accent }: { b: Identity; accent: string }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-fg-muted">Browser tab & app header</p>
        <div className="overflow-hidden rounded-ui-lg border border-line">
          <div className="flex items-center gap-2 border-b border-line bg-muted px-3 py-2">
            <Mark b={b} accent={accent} size={14} />
            <span className="truncate text-xs">{b.productName || "Product name"}</span>
          </div>
          <div className="flex items-center gap-2.5 bg-subtle px-3 py-3">
            <Mark b={b} accent={accent} size={26} />
            <span className="truncate text-sm font-semibold">{b.productName || "Product name"}</span>
          </div>
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-fg-muted">Sign-in page</p>
        <div className="rounded-ui-lg border border-line bg-surface p-5 text-center">
          <div className="mb-3 flex justify-center">
            <Mark b={b} accent={accent} size={36} />
          </div>
          <p className="text-base font-semibold">{b.loginHeadline || "Headline"}</p>
          <p className="mt-0.5 text-[13px] text-fg-muted">{b.loginTagline}</p>
          <div className="mx-auto mt-4 h-8 max-w-56 rounded-ui border border-line bg-bg" />
          <div className="mx-auto mt-2 flex h-8 max-w-56 items-center justify-center rounded-ui text-xs font-medium" style={{ background: accent, color: readableOn(accent) }}>
            Sign in
          </div>
          {(b.footerText || b.supportEmail) && (
            <p className="mt-4 text-[11px] text-fg-faint">
              {b.footerText}
              {b.footerText && b.supportEmail && " · "}
              {b.supportEmail && `Help: ${b.supportEmail}`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

/** Admin → Branding: names, logo, sign-in copy and system emails. */
export function AdminBranding() {
  const current = useBrand();
  const qc = useQueryClient();
  const canManage = useCanManage();
  const [b, setB] = useState<Identity>(identityOf(current));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const saved = identityOf(current);
  const changed = IDENTITY_KEYS.filter((k) => b[k] !== saved[k]);
  const dirty = changed.length > 0;

  // Pick up saved changes (a logo upload, another admin) while nothing is being edited.
  const savedJson = JSON.stringify(saved);
  const lastSaved = useRef(savedJson);
  useEffect(() => {
    if (JSON.stringify(b) === lastSaved.current) setB(JSON.parse(savedJson));
    lastSaved.current = savedJson;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedJson]);
  useUnsavedChangesGuard(dirty, "Your branding changes haven't been saved.");

  const set = <K extends keyof Identity>(k: K, v: Identity[K]) => setB((x) => ({ ...x, [k]: v }));
  const problem = !b.companyName.trim() && changed.includes("companyName") ? "Enter your company name." : !b.productName.trim() ? "Enter a product name." : !b.monogram.trim() ? "Enter a monogram." : null;

  const save = async () => {
    setBusy(true);
    try {
      // Only what changed, so untouched fields never trip validation.
      const body = Object.fromEntries(changed.map((k) => [k, b[k]]));
      const next = await api.put<Brand>("admin/settings/brand", body);
      qc.setQueryData(["brand"], next);
      lastSaved.current = JSON.stringify(identityOf(next));
      setB(identityOf(next));
      toast.success("Branding saved");
      if (changed.some((k) => k === "logoUrl" || k === "monogram")) {
        regenerateAppIcons(next).catch(() => toast.error("Couldn't update the app icon. Save again to retry."));
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadLogo = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    setUploading(true);
    try {
      const next = await api.post<Brand>("admin/settings/logo", form);
      qc.setQueryData(["brand"], next);
      set("logoUrl", next.logoUrl);
      lastSaved.current = JSON.stringify({ ...b, logoUrl: next.logoUrl });
      toast.success("Logo updated");
      regenerateAppIcons(next).catch(() => toast.error("Couldn't update the app icon. Save again to retry."));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Branding"
        description="Your names, logo and the words people see when they sign in or get an email from the app."
        actions={
          <Link to="/admin/appearance" className="inline-flex h-8 items-center gap-1.5 rounded-ui px-3 text-[13px] font-medium text-fg-muted hover:bg-muted hover:text-fg">
            <Palette className="size-4" /> Colors & fonts
          </Link>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <Section title="Names">
            <Grid>
              <Field label="Company name" hint="Shown in system emails and the app's description.">
                <Input value={b.companyName} onChange={(e) => set("companyName", e.target.value)} maxLength={120} disabled={!canManage} placeholder="Acme Inc." />
              </Field>
              <Field label="Product name" hint="The app's name in the header and browser tab.">
                <Input value={b.productName} onChange={(e) => set("productName", e.target.value)} maxLength={120} disabled={!canManage} />
              </Field>
              <Field label="Default sender name" hint="Used when a mailbox has no sender name of its own." className="sm:col-span-2">
                <Input value={b.defaultFromName} onChange={(e) => set("defaultFromName", e.target.value)} maxLength={120} disabled={!canManage} placeholder="e.g. Acme Support" />
              </Field>
            </Grid>
          </Section>

          <Section title="Logo" description="Used in the app, the browser tab, system emails and the home-screen icon.">
            <div className="flex flex-wrap items-center gap-5">
              <div className="flex size-16 items-center justify-center rounded-ui-lg border border-line bg-subtle p-1.5">
                <Mark b={b} accent={current.theme.accent} size={48} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button icon={<ImageUp className="size-4" />} loading={uploading} disabled={!canManage} onClick={() => logoInput.current?.click()}>
                    {b.logoUrl ? "Replace logo" : "Upload logo"}
                  </Button>
                  {b.logoUrl && (
                    <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={!canManage} onClick={() => set("logoUrl", "")}>
                      Use monogram
                    </Button>
                  )}
                </div>
                <p className="text-xs text-fg-muted">Square PNG or SVG, at least 128×128, under 1 MB.</p>
              </div>
              <Field label="Monogram" hint="1–3 letters, shown without a logo." className="w-36">
                <Input value={b.monogram} maxLength={3} onChange={(e) => set("monogram", e.target.value.toUpperCase())} disabled={!canManage} />
              </Field>
              <input
                ref={logoInput}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void uploadLogo(f);
                }}
              />
            </div>
          </Section>

          <Section title="Sign-in page">
            <Grid>
              <Field label="Headline" className="sm:col-span-2">
                <Input value={b.loginHeadline} onChange={(e) => set("loginHeadline", e.target.value)} maxLength={120} disabled={!canManage} />
              </Field>
              <Field label="Tagline" className="sm:col-span-2">
                <Textarea value={b.loginTagline} onChange={(e) => set("loginTagline", e.target.value)} rows={2} maxLength={240} disabled={!canManage} />
              </Field>
            </Grid>
          </Section>

          <Section title="Help & footer">
            <Grid>
              <Field label="Support email" hint="Where people go for help. Shown on sign-in pages and in emails.">
                <Input type="email" value={b.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} maxLength={254} disabled={!canManage} placeholder="help@example.com" />
              </Field>
              <Field label="Footer text" hint="Small print on sign-in pages and system emails.">
                <Input value={b.footerText} onChange={(e) => set("footerText", e.target.value)} maxLength={200} disabled={!canManage} placeholder="© Acme Inc." />
              </Field>
            </Grid>
          </Section>

          <Section title="System emails" description="Invitations, password resets and security alerts use your logo, colors and footer automatically. Save first, then preview.">
            <div className="grid gap-2 sm:grid-cols-2">
              {EMAILS.map((t) => (
                <a
                  key={t.name}
                  href={`/api/admin/email-preview/${t.name}`}
                  target="_blank"
                  rel="noopener"
                  className="group flex items-center gap-3 rounded-ui border border-line p-3 transition-colors hover:border-line-strong hover:bg-subtle"
                >
                  <span className="flex size-8 items-center justify-center rounded-ui-sm bg-accent-soft text-accent">
                    <t.icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{t.label}</span>
                    <span className="block truncate text-xs text-fg-muted">{t.hint}</span>
                  </span>
                  <ExternalLink className="size-3.5 text-fg-faint group-hover:text-fg" />
                </a>
              ))}
            </div>
          </Section>
        </div>

        <aside className="min-w-0 xl:sticky xl:top-0 xl:self-start">
          <IdentityPreview b={b} accent={current.theme.accent} />
        </aside>
      </div>

      {(dirty || busy) && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center gap-3 rounded-ui-lg border border-line bg-raised px-4 py-2.5 shadow-ui-lg">
          <span className="text-[13px] text-fg-muted">{problem ?? `${changed.length} unsaved change${changed.length === 1 ? "" : "s"}`}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setB(saved)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!canManage || !!problem} onClick={save}>
            Save branding
          </Button>
        </div>
      )}
    </div>
  );
}
