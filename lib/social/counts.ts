// Public pages often put their audience in the description they show to anyone, logged in or not:
// "The Home Edit, Nashville. 621,509 followers · 8,641 talking about this". This reads those counts.
// The description comes from the audited site's own profile, so nothing but a number and one of a
// fixed set of labels is ever copied out of it: no surrounding text can reach the report.

const COUNT = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.(\d{1,2}))?\s?([KMB])?\s+(followers?|likes?|following|posts?|subscribers?|talking about this)(?![a-z])/gi;
const MAX_COUNTS = 3;

/** For example "621,509 followers, 8,641 talking about this", or null when the text shows no counts. */
export function publicCountsNote(text: string): string | null {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const m of text.matchAll(COUNT)) {
    const label = m[4].toLowerCase();
    const key = label.replace(/s$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(`${m[1]}${m[2] ? `.${m[2]}` : ""}${m[3] ? m[3].toUpperCase() : ""} ${label}`);
    if (found.length === MAX_COUNTS) break;
  }
  return found.length > 0 ? found.join(", ") : null;
}
