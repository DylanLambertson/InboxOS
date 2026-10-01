import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Inbox, KeyRound, MailCheck, PartyPopper, RotateCcw, ShieldCheck, Upload, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_BRAND, type Brand } from "@shared/brand";
import { radiusValue, type ThemeTokens } from "@shared/theme";
import { api, errorMessage } from "@/lib/api";
import { regenerateAppIcons } from "@/lib/app-icons";
import { applyBrand, readableOn, useBrand } from "@/lib/brand";
import { Button, Field, Input, PageHeader, Section, Select, Textarea } from "@/components/ui/primitives";
import { useConfirm } from "@/components/ui/overlay";

const FONT_PRESETS: { label: string; google: string; stack: string }[] = [
  { label: "Inter", google: "Inter", stack: DEFAULT_BRAND.theme.fontFamily },
  { label: "Geist", google: "Geist", stack: '"Geist", ui-sans-serif, system-ui, sans-serif' },
  { label: "Manrope", google: "Manrope", stack: '"Manrope", ui-sans-serif, system-ui, sans-serif' },
  { label: "DM Sans", google: "DM Sans", stack: '"DM Sans", ui-sans-serif, system-ui, sans-serif' },
  { label: "IBM Plex Sans", google: "IBM Plex Sans", stack: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif' },
  { label: "System default", google: "", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
];

const ACCENTS = ["#4f46e5", "#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#e11d48", "#9333ea", "#18181b"];

function Preview({ b }: { b: Brand }) {
  const fg = readableOn(b.theme.accent);
  const r = radiusValue(b.theme.radius);
  return (
    <div className="overflow-hidden rounded-ui-lg border border-line bg-subtle" style={{ fontFamily: b.theme.fontFamily }}>
      <div className="flex h-56">
        <div className="w-40 border-r border-line bg-subtle p-3">
          <div className="mb-3 flex items-center gap-2">
            {b.logoUrl ? (
              <img src={b.logoUrl} alt="" className="size-6 object-contain" style={{ borderRadius: r }} />
            ) : (
              <span className="flex size-6 items-center justify-center text-[10px] font-bold" style={{ background: b.theme.accent, color: fg, borderRadius: r }}>
                {b.monogram}
              </span>
            )}
            <span className="truncate text-xs font-semibold">{b.productName}</span>
          </div>
          <div className="mb-3 py-1.5 text-center text-[11px] font-medium" style={{ background: b.theme.accent, color: fg, borderRadius: r }}>
            Compose
          </div>
          <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] font-medium" style={{ background: `color-mix(in oklab, ${b.theme.accent} 12%, transparent)`, color: b.theme.accent, borderRadius: r }}>
            <Inbox className="size-3" /> Inbox
          </div>
          {["Starred", "Sent", "Drafts"].map((x) => (
            <div key={x} className="px-1.5 py-1 text-[11px] text-fg-muted">{x}</div>
          ))}
        </div>
        <div className="flex-1 bg-bg p-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="mb-2 flex gap-2 border-b border-line pb-2">
              <span className="size-5 rounded-full bg-muted" />
              <div className="flex-1 space-y-1">
                <div className="h-2 w-1/3 rounded bg-line-strong" />
                <div className="h-2 w-2/3 rounded bg-muted" />
              </div>
              {i === 0 && <span className="mt-1 size-1.5 rounded-full" style={{ background: b.theme.accent }} />}
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-line bg-surface p-4 text-center">
        <p className="text-sm font-semibold">{b.loginHeadline}</p>
        <p className="text-xs text-fg-muted">{b.loginTagline}</p>
      </div>
    </div>
  );
}

export function AdminBranding() {
  const current = useBrand();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [b, setB] = useState<Brand>(current);
  const [busy, setBusy] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(b) !== JSON.stringify(current);

  // Keep the raw text so typing a comma or space isn't swallowed by the round-trip through the array.
  const [domainsText, setDomainsText] = useState(current.additionalDomains.join(", "));

  useEffect(() => (setB(current), setDomainsText(current.additionalDomains.join(", "))), [current]);
  // Restore the saved brand if the admin leaves without saving.
  useEffect(() => () => applyBrand(current), [current]);

  const set = <K extends keyof Brand>(k: K, v: Brand[K]) => setB((x) => ({ ...x, [k]: v }));
  const setTheme = (patch: Partial<ThemeTokens>) => setB((x) => ({ ...x, theme: { ...x.theme, ...patch } }));

  const save = async (next = b) => {
    setBusy(true);
    try {
      const saved = await api.put<Brand>("admin/settings/brand", next as unknown as Record<string, unknown>);
      qc.setQueryData(["brand"], saved);
      toast.success("Branding saved");
      // Keep the home-screen app icon in step with the logo, colors and monogram.
      regenerateAppIcons(saved).catch(() => toast.error("Couldn't update the app icon. Save again to retry."));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadLogo = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    try {
      const saved = await api.post<Brand>("admin/settings/logo", form);
      qc.setQueryData(["brand"], saved);
      toast.success("Logo updated");
      regenerateAppIcons(saved).catch(() => toast.error("Couldn't update the app icon. Save again to retry."));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const fontPreset = FONT_PRESETS.find((f) => f.stack === b.theme.fontFamily)?.label ?? "custom";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Branding"
        description="White-label every customer-facing detail. Changes apply to everyone instantly."
        actions={
          <>
            <Button
              variant="ghost"
              icon={<RotateCcw className="size-4" />}
              onClick={async () => {
                if (await confirm({ title: "Reset branding to defaults?", confirmLabel: "Reset" })) {
                  setB(DEFAULT_BRAND);
                  setDomainsText(DEFAULT_BRAND.additionalDomains.join(", "));
                  save(DEFAULT_BRAND);
                }
              }}
            >
              Reset
            </Button>
            <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => save()}>
              Save changes
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Section title="Identity">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Company name">
                <Input value={b.companyName} onChange={(e) => set("companyName", e.target.value)} />
              </Field>
              <Field label="Product name" hint="Shown in the app header and browser tab.">
                <Input value={b.productName} onChange={(e) => set("productName", e.target.value)} />
              </Field>
              <Field label="Primary domain" hint="Default domain for new mailboxes and system email.">
                <Input value={b.primaryDomain} onChange={(e) => set("primaryDomain", e.target.value)} />
              </Field>
              <Field label="Default sender name" hint="Used when a mailbox has no sender name.">
                <Input value={b.defaultFromName} onChange={(e) => set("defaultFromName", e.target.value)} />
              </Field>
              <Field
                label="Additional domains"
                hint="Comma-separated. Every mailbox also gets its address on these domains, and people can switch between them when sending. Verify each one in Resend first."
                className="sm:col-span-2"
              >
                <Input
                  value={domainsText}
                  onChange={(e) => {
                    setDomainsText(e.target.value);
                    set("additionalDomains", e.target.value.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean));
                  }}
                  placeholder="example.co"
                />
              </Field>
            </div>
          </Section>

          <Section title="Logo">
            <div className="flex flex-wrap items-center gap-4">
              {b.logoUrl ? (
                <img src={b.logoUrl} alt="Logo" className="size-14 rounded-ui border border-line object-contain p-1" />
              ) : (
                <span className="flex size-14 items-center justify-center rounded-ui text-lg font-bold" style={{ background: b.theme.accent, color: readableOn(b.theme.accent) }}>
                  {b.monogram}
                </span>
              )}
              <div className="flex flex-wrap gap-2">
                <Button icon={<Upload className="size-4" />} onClick={() => logoInput.current?.click()}>
                  Upload logo
                </Button>
                {b.logoUrl && <Button variant="ghost" onClick={() => set("logoUrl", "")}>Remove</Button>}
              </div>
              <Field label="Monogram" hint="Shown when there's no logo." className="w-28">
                <Input value={b.monogram} maxLength={3} onChange={(e) => set("monogram", e.target.value.toUpperCase())} />
              </Field>
              <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" hidden onChange={(e) => (e.target.files?.[0] && uploadLogo(e.target.files[0]), (e.target.value = ""))} />
            </div>
            <p className="mt-3 text-xs text-fg-muted">Square PNG or SVG, at least 128×128, under 1 MB. Also used as the browser tab icon.</p>
          </Section>

          <Section title="Look & feel">
            <div className="space-y-5">
              <Field label="Accent color">
                <div className="flex flex-wrap items-center gap-2">
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      aria-label={c}
                      onClick={() => setTheme({ accent: c })}
                      className={`size-7 rounded-full ring-offset-2 ring-offset-surface ${b.theme.accent === c ? "ring-2 ring-fg" : ""}`}
                      style={{ background: c }}
                    />
                  ))}
                  <label className="relative flex h-8 items-center gap-2 rounded-ui border border-line px-2 text-[13px]">
                    <input type="color" value={b.theme.accent} onChange={(e) => setTheme({ accent: e.target.value })} className="size-5 cursor-pointer border-0 bg-transparent p-0" />
                    <input value={b.theme.accent} onChange={(e) => /^#[0-9a-f]{0,6}$/i.test(e.target.value) && setTheme({ accent: e.target.value })} className="w-20 bg-transparent font-mono text-xs outline-none" />
                  </label>
                </div>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Corner radius">
                  <Select value={b.theme.radius} onChange={(e) => setTheme({ radius: e.target.value as ThemeTokens["radius"] })}>
                    <option value="none">Square</option>
                    <option value="sm">Subtle</option>
                    <option value="md">Rounded</option>
                    <option value="lg">Soft</option>
                  </Select>
                </Field>
                <Field label="Font">
                  <Select
                    value={fontPreset}
                    onChange={(e) => {
                      const f = FONT_PRESETS.find((x) => x.label === e.target.value);
                      if (f) setTheme({ fontFamily: f.stack, googleFont: f.google });
                    }}
                  >
                    {FONT_PRESETS.map((f) => (
                      <option key={f.label}>{f.label}</option>
                    ))}
                    {fontPreset === "custom" && <option value="custom">Custom</option>}
                  </Select>
                </Field>
              </div>
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => applyBrand(b)}>
                  Preview across the app
                </Button>
              </div>
            </div>
          </Section>

          <Section title="System emails" description="Invitations, password resets and security alerts use your logo, colors and footer automatically. Save your changes, then preview.">
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { name: "invite", label: "Invitation", hint: "Account claim link", icon: UserPlus },
                { name: "welcome", label: "Welcome", hint: "After someone joins", icon: PartyPopper },
                { name: "unreadDigest", label: "Unread digest", hint: "To a personal email", icon: Inbox },
                { name: "verifyPersonalEmail", label: "Confirm personal email", hint: "Before digests start", icon: MailCheck },
                { name: "reset", label: "Password reset", hint: "Forgot password / admin reset", icon: KeyRound },
                { name: "passwordChanged", label: "Password changed", hint: "Security alert", icon: ShieldCheck },
                { name: "twoFactor", label: "Two-factor changed", hint: "Security alert", icon: ShieldCheck },
                { name: "newSignIn", label: "New sign-in", hint: "New device or country", icon: ShieldCheck },
                { name: "passkeyAdded", label: "Passkey added", hint: "Security alert", icon: ShieldCheck },
              ].map((t) => (
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

          <Section title="Sign-in page & footer">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Headline">
                <Input value={b.loginHeadline} onChange={(e) => set("loginHeadline", e.target.value)} />
              </Field>
              <Field label="Support email">
                <Input type="email" value={b.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} />
              </Field>
              <Field label="Tagline" className="sm:col-span-2">
                <Textarea value={b.loginTagline} onChange={(e) => set("loginTagline", e.target.value)} rows={2} />
              </Field>
              <Field label="Footer text" className="sm:col-span-2">
                <Input value={b.footerText} onChange={(e) => set("footerText", e.target.value)} />
              </Field>
            </div>
          </Section>
        </div>

        <div className="xl:sticky xl:top-0 xl:self-start">
          <p className="mb-2 text-xs font-medium text-fg-muted">Live preview</p>
          <Preview b={b} />
        </div>
      </div>
    </div>
  );
}
