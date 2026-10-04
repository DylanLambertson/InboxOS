import { useDeferredValue, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Search, UserPen, Users } from "lucide-react";
import type { Teammate } from "@shared/profile";
import { api } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { useMe } from "@/lib/queries";
import { TeammateCard, useNow } from "@/components/people/TeammateCard";
import { EmptyState, Input, LoadError, PageHeader, Select, Spinner } from "@/components/ui/primitives";

export const usePeople = () => useQuery({ queryKey: ["people"], queryFn: () => api.get<Teammate[]>("people"), staleTime: 5 * 60_000 });

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const haystack = (t: Teammate) => fold([t.name, t.email, t.jobTitle, t.department, t.location, t.pronouns, t.timezone].join(" "));

/** The team directory: everyone active in the workspace. */
export function PeoplePage() {
  const { data: people, isLoading, error, refetch } = usePeople();
  const { data: me } = useMe();
  const brand = useBrand();
  const now = useNow();
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const query = useDeferredValue(q);

  const departments = useMemo(() => [...new Set((people ?? []).map((p) => p.department).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [people]);
  const index = useMemo(() => (people ?? []).map((p) => [p, haystack(p)] as const), [people]);
  const shown = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    return index.filter(([p, text]) => (!dept || p.department === dept) && terms.every((t) => text.includes(t))).map(([p]) => p);
  }, [index, query, dept]);

  const org = brand.companyName || brand.productName;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
        <PageHeader
          title="People"
          description={people ? `${people.length} ${people.length === 1 ? "person" : "people"} at ${org}.` : `Everyone at ${org}.`}
          actions={
            <Link to="/settings/profile" className="inline-flex h-8 items-center gap-1.5 rounded-ui border border-line bg-surface px-3 text-[13px] font-medium shadow-ui-sm hover:bg-subtle">
              <UserPen className="size-4" /> Edit your profile
            </Link>
          }
        />

        <div className="mb-5 flex flex-wrap gap-2">
          <div className="relative min-w-0 flex-1 basis-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, title, team or place" className="pl-9" aria-label="Search people" autoFocus />
          </div>
          {departments.length > 1 && (
            <Select value={dept} onChange={(e) => setDept(e.target.value)} className="w-52" aria-label="Department">
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          )}
        </div>

        {error ? (
          <LoadError error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-5" />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState icon={<Users className="size-5" />} title={q || dept ? "No one matches" : "No teammates yet"} body={q || dept ? "Try a different name, title or department." : undefined} />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => (
              <li key={p.id} className="flex">
                <TeammateCard t={p} now={now} isMe={p.id === me?.id} className="flex-1" />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
