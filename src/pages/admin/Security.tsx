import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Search, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import type { Brand, OrgPolicy } from "@shared/brand";
import { api, errorMessage } from "@/lib/api";
import { longDate, relativeTime } from "@/lib/format";
import { useCanManage, useMe } from "@/lib/queries";
import { Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, LoadError, PageHeader, Section, Select, Spinner, Textarea } from "@/components/ui/primitives";
import { Tabs, useConfirm } from "@/components/ui/overlay";

interface OrgSession {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  ip: string | null;
  device: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

interface SignIn {
  id: string;
  created_at: string;
  user_id: string | null;
  email: string | null;
  outcome: "success" | "failed" | "locked" | "2fa_failed" | "blocked";
  method: string;
  reason: string | null;
  ip: string | null;
  device: string | null;
  country: string | null;
}

interface Stats {
  failed24h: number;
  blocked24h: number;
  signIns24h: number;
  countries30d: number;
  activeSessions: number;
  countries: { country: string; n: number }[];
}

type Tab = "sessions" | "activity" | "access";

const OUTCOMES: Record<SignIn["outcome"], { label: string; tone: "success" | "danger" | "warning" }> = {
  success: { label: "Signed in", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  "2fa_failed": { label: "Wrong 2FA code", tone: "danger" },
  locked: { label: "Locked", tone: "warning" },
  blocked: { label: "Blocked network", tone: "warning" },
};

const METHODS: Record<string, string> = { password: "Password", "password+2fa": "Password + 2FA", google: "Google", session: "Existing session" };

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function Stat({ label, value, hint, alert }: { label: string; value: number | undefined; hint?: string; alert?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${alert ? "text-danger" : ""}`}>{value ?? "–"}</p>
      {hint && <p className="mt-0.5 text-xs text-fg-muted">{hint}</p>}
    </Card>
  );
}

export function AdminSecurity() {
  const { tab = "sessions" } = useParams();
  const navigate = useNavigate();
  const [userFilter, setUserFilter] = useState("");
  const { data: stats } = useQuery({ queryKey: ["admin-security-stats"], queryFn: () => api.get<Stats>("admin/security/stats"), refetchInterval: 60_000 });
  if (!["sessions", "activity", "access"].includes(tab)) return <Navigate to="/admin/security" replace />;
  const showHistory = (userId: string) => {
    setUserFilter(userId);
    navigate("/admin/security/activity");
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Security" description="Who is signed in, every sign-in attempt, and where people may sign in from." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active sessions" value={stats?.activeSessions} />
        <Stat label="Sign-ins (24h)" value={stats?.signIns24h} />
        <Stat label="Failed sign-ins (24h)" value={stats?.failed24h} alert={!!stats?.failed24h} hint={stats?.blocked24h ? `${stats.blocked24h} from blocked networks` : undefined} />
        <Stat
          label="Countries (30 days)"
          value={stats?.countries30d}
          hint={stats?.countries.length ? stats.countries.slice(0, 4).map((c) => c.country).join(", ") : undefined}
        />
      </div>
      <Tabs<Tab>
        value={tab as Tab}
        onChange={(v) => navigate(v === "sessions" ? "/admin/security" : `/admin/security/${v}`)}
        tabs={[
          { value: "sessions", label: "Sessions" },
          { value: "activity", label: "Sign-in activity" },
          { value: "access", label: "Access policy" },
        ]}
      />
      {tab === "sessions" && <SessionsTab onHistory={showHistory} />}
      {tab === "activity" && <ActivityTab user={userFilter} setUser={setUserFilter} />}
      {tab === "access" && <AccessTab />}
    </div>
  );
}

// ---- Sessions -------------------------------------------------------------

function SessionsTab({ onHistory }: { onHistory: (userId: string) => void }) {
  const editable = useCanManage();
  const { data: me } = useMe();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const { data = [], isLoading, error, refetch } = useQuery({
    queryKey: ["admin-sessions", dq],
    queryFn: () => api.get<OrgSession[]>(`admin/security/sessions?q=${encodeURIComponent(dq)}`),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-sessions"] });
    qc.invalidateQueries({ queryKey: ["admin-security-stats"] });
  };
  // Admins can't sign out owners; the server enforces it too.
  const mayManage = (s: OrgSession) => editable && (s.role !== "owner" || me?.role === "owner");

  const revoke = async (s: OrgSession) => {
    if (!(await confirm({ title: `Sign out ${s.name || s.email}?`, body: `Ends the ${s.device} session from ${s.ip ?? "an unknown IP"}.`, confirmLabel: "Sign out", danger: true }))) return;
    try {
      await api.del(`admin/security/sessions/${s.id}`);
      toast.success("Session ended");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const revokeAll = async (s: OrgSession) => {
    const self = s.userId === me?.id;
    const body = self ? "Signs you out on every other device. This session stays signed in." : "They'll need to sign in again on every device.";
    if (!(await confirm({ title: `Sign out ${self ? "your other sessions" : `${s.name || s.email} everywhere`}?`, body, confirmLabel: "Sign out everywhere", danger: true }))) return;
    try {
      const r = await api.post<{ count: number }>(`admin/security/users/${s.userId}/revoke-sessions`);
      toast.success(`Ended ${r.count} session${r.count === 1 ? "" : "s"}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (error && !data.length) return <LoadError error={error} onRetry={() => refetch()} />;
  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by person, IP or browser…" className="pl-8" />
      </div>
      <Card className="overflow-x-auto">
        {isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : !data.length ? (
          <EmptyState title="No active sessions" body={dq ? "No sessions match your search." : undefined} />
        ) : (
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="border-b border-line text-left text-xs text-fg-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Person</th>
                <th className="px-3 py-2.5 font-medium">Device</th>
                <th className="px-3 py-2.5 font-medium">IP address</th>
                <th className="px-3 py-2.5 font-medium">Signed in</th>
                <th className="px-3 py-2.5 font-medium">Last active</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((s) => (
                <tr key={s.id} className="hover:bg-subtle">
                  <td className="max-w-56 px-5 py-2.5">
                    <button className="block max-w-full truncate text-left font-medium hover:underline" onClick={() => onHistory(s.userId)} title="Show sign-in history">
                      {s.name || s.email}
                    </button>
                    <span className="block truncate text-xs text-fg-muted">{s.email}</span>
                  </td>
                  <td className="px-3 py-2.5" title={s.userAgent ?? undefined}>
                    {s.device} {s.current && <Badge tone="accent" className="ml-1">You</Badge>}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{s.ip ?? "—"}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-fg-muted" title={longDate(s.createdAt)}>{relativeTime(s.createdAt)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-fg-muted" title={longDate(s.lastSeenAt)}>{relativeTime(s.lastSeenAt)}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    {mayManage(s) && (
                      <>
                        {!s.current && (
                          <IconButton label="End this session" onClick={() => revoke(s)}>
                            <X className="size-4" />
                          </IconButton>
                        )}
                        <IconButton label="Sign out everywhere" onClick={() => revokeAll(s)}>
                          <LogOut className="size-4" />
                        </IconButton>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---- Sign-in activity -----------------------------------------------------

function ActivityTab({ user, setUser }: { user: string; setUser: (v: string) => void }) {
  const [q, setQ] = useState("");
  const [failed, setFailed] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const dq = useDebounced(q);
  const { data: users = [] } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<{ id: string; email: string; name: string }[]>("admin/users") });
  const list = useInfiniteQuery({
    queryKey: ["admin-sign-ins", user, dq, failed, from, to],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ user, q: dq, from, to, cursor: pageParam, limit: "50" });
      if (failed) qs.set("failed", "1");
      return api.get<{ items: SignIn[]; nextCursor: string | null }>(`admin/security/sign-ins?${qs}`);
    },
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(user || dq || failed || from || to);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email, IP, country code or browser…" className="pl-8" />
        </div>
        <Select value={user} onChange={(e) => setUser(e.target.value)} className="w-56" aria-label="Person">
          <option value="">Everyone</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
        </Select>
        <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From date" />
        <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To date" />
        <Checkbox checked={failed} onChange={setFailed} label="Failed only" />
      </div>
      <Card className="overflow-x-auto">
        {list.isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : list.error && !rows.length ? (
          <LoadError error={list.error} onRetry={() => list.refetch()} />
        ) : !rows.length ? (
          <EmptyState title="No sign-ins yet" body={filtered ? "No sign-ins match your filters." : "Sign-in attempts appear here as they happen."} />
        ) : (
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="border-b border-line text-left text-xs text-fg-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Time</th>
                <th className="px-3 py-2.5 font-medium">Result</th>
                <th className="px-3 py-2.5 font-medium">Person</th>
                <th className="px-3 py-2.5 font-medium">Method</th>
                <th className="px-3 py-2.5 font-medium">Country</th>
                <th className="px-3 py-2.5 font-medium">IP / device</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const o = OUTCOMES[r.outcome] ?? { label: r.outcome, tone: "warning" as const };
                return (
                  <tr key={r.id} className="hover:bg-subtle">
                    <td className="px-5 py-2.5 whitespace-nowrap text-fg-muted">{longDate(r.created_at)}</td>
                    <td className="px-3 py-2.5" title={r.reason?.replace(/_/g, " ") ?? undefined}>
                      <Badge tone={o.tone}>{o.label}</Badge>
                    </td>
                    <td className="max-w-56 truncate px-3 py-2.5">
                      {r.user_id ? (
                        <button className="hover:underline" onClick={() => setUser(r.user_id!)}>{r.email ?? r.user_id}</button>
                      ) : (
                        <span className="text-fg-muted">{r.email ?? "—"}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-fg-muted">{METHODS[r.method] ?? r.method}</td>
                    <td className="px-3 py-2.5">{r.country ?? "—"}</td>
                    <td className="max-w-64 truncate px-3 py-2.5 text-fg-muted">
                      <span className="font-mono text-xs">{r.ip ?? "—"}</span> · {r.device ?? "Unknown device"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Load more</Button>
        </div>
      )}
    </div>
  );
}

// ---- Access policy --------------------------------------------------------

function AccessTab() {
  const editable = useCanManage();
  const qc = useQueryClient();
  const { data, error, refetch } = useQuery({ queryKey: ["admin-settings"], queryFn: () => api.get<{ brand: Brand; policy: OrgPolicy }>("admin/settings") });
  const { data: net } = useQuery({ queryKey: ["admin-security-network"], queryFn: () => api.get<{ ip: string | null; insideAllowlist: boolean }>("admin/security/network") });
  const [text, setText] = useState("");
  const [mode, setMode] = useState<OrgPolicy["ipAllowlistEnforceFor"]>("everyone");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) {
      setText(data.policy.ipAllowlist.join("\n"));
      setMode(data.policy.ipAllowlistEnforceFor);
    }
  }, [data]);
  if (error && !data) return <LoadError error={error} onRetry={() => refetch()} />;
  if (!data) return <Spinner />;

  const entries = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const addMine = () => net?.ip && !entries.includes(net.ip) && setText((t) => `${t.trim() ? `${t.trim()}\n` : ""}${net.ip}`);
  const save = async () => {
    setBusy(true);
    try {
      await api.put("admin/settings/policy", { ipAllowlist: entries, ipAllowlistEnforceFor: mode });
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
      qc.invalidateQueries({ queryKey: ["admin-security-network"] });
      toast.success(entries.length ? "IP allowlist saved" : "IP allowlist turned off");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="IP allowlist"
      description={editable ? "Only allow sign-in and app access from these networks. Leave empty to allow any network." : "Only owners and admins can change this."}
      actions={editable && <Button variant="primary" loading={busy} onClick={save}>Save</Button>}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3 rounded-ui border border-line bg-subtle px-4 py-3 text-[13px]">
          <ShieldCheck className="size-4 text-fg-muted" />
          <span>
            Your IP address: <span className="font-mono">{net?.ip ?? "unknown"}</span>
            {data.policy.ipAllowlist.length > 0 && (net?.insideAllowlist ? <Badge tone="success" className="ml-2">Allowed</Badge> : <Badge tone="danger" className="ml-2">Not in list</Badge>)}
          </span>
          {editable && net?.ip && !entries.includes(net.ip) && (
            <Button size="xs" className="ml-auto" onClick={addMine}>Add my IP</Button>
          )}
        </div>
        <Field label="Allowed addresses and ranges" hint="One per line. IPv4 or IPv6, single addresses or CIDR ranges like 203.0.113.0/24 or 2001:db8::/32.">
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} disabled={!editable} placeholder={"203.0.113.0/24\n2001:db8::/32"} className="font-mono text-xs" />
        </Field>
        <Field label="Applies to" hint="Checked when signing in and on every request, so leaving an allowed network ends access right away. You can only save a list that includes your own address.">
          <Select value={mode} onChange={(e) => setMode(e.target.value as OrgPolicy["ipAllowlistEnforceFor"])} disabled={!editable} className="w-auto">
            <option value="everyone">Everyone</option>
            <option value="admins">Only owners, admins and managers</option>
          </Select>
        </Field>
      </div>
    </Section>
  );
}
