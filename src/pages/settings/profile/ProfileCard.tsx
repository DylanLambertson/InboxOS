import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeWebsite, PROFILE_LIMITS, type Teammate } from "@shared/profile";
import type { Me } from "@shared/types";
import { api, errorMessage } from "@/lib/api";
import { useUnsavedChangesGuard } from "@/lib/unsaved";
import { TeammateCard, useNow } from "@/components/people/TeammateCard";
import { Button, Field, Input, Section, Textarea } from "@/components/ui/primitives";
import { AvatarEditor } from "./AvatarEditor";
import { browserTimeZone, TimeZoneSelect } from "./TimeZoneSelect";

const FIELDS = ["name", "jobTitle", "department", "pronouns", "phone", "location", "timezone", "website", "bio"] as const;
type Draft = Record<(typeof FIELDS)[number], string>;

const PRONOUNS = ["she/her", "he/him", "they/them", "she/they", "he/they"];

/** The saved profile, with the browser's time zone suggested when none is set yet. */
const draftOf = (me: Me): Draft => ({
  name: me.name,
  jobTitle: me.jobTitle,
  department: me.department,
  pronouns: me.pronouns,
  phone: me.phone,
  location: me.location,
  timezone: me.timezone || browserTimeZone(),
  website: me.website,
  bio: me.bio,
});

function Counter({ value, max }: { value: string; max: number }) {
  return <span className={value.length > max * 0.9 ? "text-warning" : undefined}>{`${value.length}/${max}`}</span>;
}

/** Settings → Profile: photo, details and a preview of how teammates see you. */
export function ProfileCard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const now = useNow();
  // Only the profile fields: changing a preference elsewhere on the page mustn't reset the form.
  const baselineKey = JSON.stringify(draftOf(me));
  const baseline = useMemo(() => JSON.parse(baselineKey) as Draft, [baselineKey]);
  const [d, setD] = useState<Draft>(baseline);
  const [saving, setSaving] = useState(false);
  const prev = useRef(baseline);
  useEffect(() => {
    // Take saved changes from elsewhere (another tab) unless there are edits here.
    setD((cur) => (FIELDS.every((k) => cur[k].trim() === prev.current[k].trim()) ? baseline : cur));
    prev.current = baseline;
  }, [baseline]);

  const changed = FIELDS.filter((k) => d[k].trim() !== baseline[k].trim());
  // A suggested time zone counts as a change to save, but not as unsaved work worth a warning.
  const unsaved = changed.filter((k) => !(k === "timezone" && !me.timezone && d.timezone === baseline.timezone));
  const websiteError = d.website.trim() && !normalizeWebsite(d.website) ? "Use a secure https:// address, like https://example.com" : null;
  const nameError = !d.name.trim() ? "Enter your name" : null;
  useUnsavedChangesGuard(unsaved.length > 0, "Your profile changes haven't been saved.");

  const set = (k: keyof Draft, v: string) => setD((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      const body = Object.fromEntries(FIELDS.filter((k) => d[k].trim() !== (me[k] ?? "").trim()).map((k) => [k, d[k].trim()]));
      const updated = await api.patch<Me>("me", body);
      // The server normalizes some values (e.g. the website), so show what was stored.
      setD(draftOf(updated));
      prev.current = draftOf(updated);
      qc.setQueryData(["me"], updated);
      qc.invalidateQueries({ queryKey: ["org-signature"] });
      qc.invalidateQueries({ queryKey: ["people"] });
      toast.success("Profile updated");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const preview: Teammate = {
    id: me.id,
    email: me.email,
    color: me.avatarColor,
    avatarUrl: me.avatarUrl,
    name: d.name.trim(),
    jobTitle: d.jobTitle.trim(),
    phone: d.phone.trim(),
    pronouns: d.pronouns.trim(),
    department: d.department.trim(),
    location: d.location.trim(),
    timezone: d.timezone,
    website: normalizeWebsite(d.website) ?? "",
    bio: d.bio.trim(),
  };
  const needsSave = changed.length > 0 && FIELDS.some((k) => d[k].trim() !== (me[k] ?? "").trim());

  return (
    <Section title="Profile" description="How you appear to teammates in the directory, on assignments and in mentions.">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-6 sm:flex-row">
          <AvatarEditor me={me} name={d.name} />
          <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
            <Field label="Name" error={nameError}>
              <Input value={d.name} onChange={(e) => set("name", e.target.value)} maxLength={120} autoComplete="name" />
            </Field>
            <Field label="Pronouns" hint="Optional.">
              <Input value={d.pronouns} onChange={(e) => set("pronouns", e.target.value)} maxLength={PROFILE_LIMITS.pronouns} list="io-pronouns" placeholder="e.g. they/them" />
              <datalist id="io-pronouns">
                {PRONOUNS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </Field>
            <Field label="Job title" hint="Also fills your company signature.">
              <Input value={d.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} maxLength={120} placeholder="e.g. Account Manager" autoComplete="organization-title" />
            </Field>
            <Field label="Department">
              <Input value={d.department} onChange={(e) => set("department", e.target.value)} maxLength={PROFILE_LIMITS.department} placeholder="e.g. Customer Success" />
            </Field>
            <Field label="Phone" hint="Also fills your company signature.">
              <Input value={d.phone} onChange={(e) => set("phone", e.target.value)} maxLength={40} type="tel" placeholder="+1 555 123 4567" autoComplete="tel" />
            </Field>
            <Field label="Location">
              <Input value={d.location} onChange={(e) => set("location", e.target.value)} maxLength={PROFILE_LIMITS.location} placeholder="e.g. Berlin, remote" />
            </Field>
            <Field label="Time zone" htmlFor="io-tz" hint={!me.timezone && d.timezone ? "Detected from your browser. Save to share it." : "Teammates see your local time."}>
              <TimeZoneSelect id="io-tz" value={d.timezone} onChange={(v) => set("timezone", v)} />
            </Field>
            <Field label="Website" error={websiteError}>
              <Input value={d.website} onChange={(e) => set("website", e.target.value)} maxLength={PROFILE_LIMITS.website} type="url" inputMode="url" placeholder="https://" />
            </Field>
            <Field label="About you" hint={<Counter value={d.bio} max={PROFILE_LIMITS.bio} />} className="sm:col-span-2">
              <Textarea value={d.bio} onChange={(e) => set("bio", e.target.value)} maxLength={PROFILE_LIMITS.bio} rows={3} placeholder="What you work on, what to ask you about." />
            </Field>
            <div className="flex items-center justify-between gap-3 sm:col-span-2">
              <p className="text-xs text-fg-muted">Sign-in email: {me.email}. Ask an admin to change it.</p>
              <Button variant="primary" loading={saving} disabled={!needsSave || !!websiteError || !!nameError} onClick={save}>
                Save profile
              </Button>
            </div>
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-xs font-medium text-fg-muted">How teammates see you</p>
          <TeammateCard t={preview} now={now} isMe />
        </div>
      </div>
    </Section>
  );
}
