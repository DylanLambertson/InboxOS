/**
 * Matching and ranking for the command palette. Pure functions, no React, unit-tested.
 *
 * A query is split into words; every word has to match the title, a keyword or the
 * subtitle. Substring matches beat scattered-letter matches, and matches at the start
 * of a word beat matches in the middle. Recently used entries get a small boost.
 */

export interface PaletteEntry {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  keywords?: string[];
  /** Small constant nudge, e.g. to prefer pages over actions with the same name. */
  boost?: number;
}

export interface RankedGroup<T> {
  group: string;
  items: T[];
}

const BOUNDARY = /[\s\-_/@.&:(]/;
const isBoundary = (text: string, i: number) => i === 0 || BOUNDARY.test(text[i - 1]);
export const normalize = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Score one query word against one text, with the matched character positions. Null = no match. */
export function matchWord(word: string, text: string, allowScattered = true): { score: number; indices: number[] } | null {
  if (!word) return { score: 0, indices: [] };
  const t = normalize(text);
  // Prefer a substring that starts a word; fall back to any substring.
  let at = -1;
  for (let i = t.indexOf(word); i >= 0; i = t.indexOf(word, i + 1)) {
    if (isBoundary(t, i)) {
      at = i;
      break;
    }
    if (at < 0) at = i;
  }
  if (at >= 0) {
    let score = 60 + word.length * 2;
    if (at === 0) score += 30;
    else if (isBoundary(t, at)) score += 20;
    score -= Math.min(at, 20) * 0.5;
    if (t.length === word.length) score += 25;
    return { score, indices: Array.from({ length: word.length }, (_, k) => at + k) };
  }
  if (!allowScattered || word.length < 2) return null;
  // Letters in order: favour word starts and runs of consecutive letters.
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of word) {
    let found = -1;
    for (let i = t.indexOf(ch, from); i >= 0; i = t.indexOf(ch, i + 1)) {
      if (i === indices[indices.length - 1] + 1 || isBoundary(t, i)) {
        found = i;
        break;
      }
      if (found < 0) found = i;
    }
    if (found < 0) return null;
    const prev = indices[indices.length - 1];
    score += prev !== undefined && found === prev + 1 ? 5 : isBoundary(t, found) ? 4 : 1;
    score -= Math.min(found - from, 10) * 0.2;
    indices.push(found);
    from = found + 1;
  }
  // Too scattered to be what anyone meant.
  if (score < word.length * 2) return null;
  return { score, indices };
}

export const queryWords = (q: string) => normalize(q).trim().split(/\s+/).filter(Boolean);

/** Score an entry against a query, or null when some word doesn't match anywhere. */
export function scoreEntry(entry: PaletteEntry, query: string): number | null {
  const words = queryWords(query);
  if (!words.length) return 0;
  let total = 0;
  for (const w of words) {
    let best: number | null = null;
    const consider = (s: number | null | undefined, weight: number) => {
      if (s != null && (best === null || s * weight > best)) best = s * weight;
    };
    consider(matchWord(w, entry.title)?.score, 1);
    for (const k of entry.keywords ?? []) consider(matchWord(w, k)?.score, 0.8);
    if (entry.subtitle) consider(matchWord(w, entry.subtitle, false)?.score, 0.6);
    if (best === null) return null;
    total += best;
  }
  return total + (entry.boost ?? 0);
}

/** Character ranges of the title to highlight for a query. */
export function highlightRanges(title: string, query: string): [number, number][] {
  const marks = new Set<number>();
  for (const w of queryWords(query)) for (const i of matchWord(w, title)?.indices ?? []) marks.add(i);
  const sorted = [...marks].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const i of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else ranges.push([i, i + 1]);
  }
  return ranges;
}

/**
 * Rank entries for a query and group them. Groups are ordered by their best match
 * (so the top result is always first); each group keeps at most `limitPerGroup`.
 */
export function rankEntries<T extends PaletteEntry>(entries: T[], query: string, opts: { recent?: string[]; limitPerGroup?: number } = {}): RankedGroup<T>[] {
  const recent = opts.recent ?? [];
  const limit = opts.limitPerGroup ?? 6;
  const scored: { e: T; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const s = scoreEntry(e, query);
    if (s === null) return;
    const r = recent.indexOf(e.id);
    scored.push({ e, s: s + (r >= 0 ? Math.max(1, 12 - r * 2) : 0), i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const groups = new Map<string, { items: T[]; best: number }>();
  for (const { e, s } of scored) {
    const g = groups.get(e.group) ?? { items: [], best: s };
    if (g.items.length < limit) g.items.push(e);
    groups.set(e.group, g);
  }
  return [...groups.entries()].sort((a, b) => b[1].best - a[1].best).map(([group, g]) => ({ group, items: g.items }));
}

/** Most-recent-first list of ids, without duplicates. */
export function pushRecent<T extends { id: string }>(list: T[], item: T, max = 8): T[] {
  return [item, ...list.filter((x) => x.id !== item.id)].slice(0, max);
}

/** Read a stored recents list defensively (storage can hold anything). */
export function parseRecent<T extends { id: string; title: string }>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is T => !!x && typeof x.id === "string" && typeof x.title === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** Position after moving by `delta` items, wrapping around. */
export function moveIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return (((current + delta) % count) + count) % count;
}

/** Index of the first item of the next (or previous) group, given each group's size. */
export function jumpGroup(current: number, sizes: number[], direction: 1 | -1): number {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!total) return -1;
  const starts: number[] = [];
  let acc = 0;
  for (const n of sizes) {
    if (n) starts.push(acc);
    acc += n;
  }
  let g = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= current) g = i;
  const next = (g + direction + starts.length) % starts.length;
  return starts[next];
}
