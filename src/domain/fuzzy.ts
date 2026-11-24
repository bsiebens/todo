/**
 * Small fuzzy matcher for the command palette. Every query character must appear in
 * order. Matches at the start of a word, and runs of consecutive characters, score higher.
 * Returns null when the text does not match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  // A plain substring is the strongest signal; earlier is better.
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 - sub + (sub === 0 || /\W/.test(t[sub - 1]!) ? 200 : 0);

  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const wordStart = found === 0 || /\W/.test(t[found - 1]!);
    run = found === ti ? run + 1 : 0;
    score += 10 + (wordStart ? 15 : 0) + run * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score;
}

/** Items that match, best first. Ties keep the original order. */
export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}
