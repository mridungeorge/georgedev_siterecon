// Flesch reading ease: higher is easier. About 60 to 70 is plain English, below 30 is academic.
// Syllables are estimated from vowel groups, which is close enough to compare a page with a threshold.

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export interface Readability {
  /** Flesch reading ease, rounded. */
  ease: number;
  words: number;
}

/** Null when there is no text to measure. */
export function readingEase(text: string): Readability | null {
  const words = text.split(/\s+/).map((w) => w.replace(/[^A-Za-z']/g, "")).filter(Boolean);
  if (words.length === 0) return null;
  const sentences = Math.max(1, text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length);
  const syllableCount = words.reduce((sum, w) => sum + syllables(w), 0);
  const ease = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllableCount / words.length);
  return { ease: Math.round(ease), words: words.length };
}
