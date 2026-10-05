// Text from audited websites is untrusted data. These helpers do two jobs: count the things
// in it that look like instructions aimed at an AI model (shown in the report, like
// RepoRecon's injection flags), and wrap the text so the model is told it is data.

export const UNTRUSTED_OPEN = "<<<UNTRUSTED_PAGE_TEXT>>>";
export const UNTRUSTED_CLOSE = "<<<END_UNTRUSTED_PAGE_TEXT>>>";

const PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|the)\b[^.\n]{0,20}\binstructions?\b/gi,
  /\byou are now\b/gi,
  /\b(reveal|show|print|repeat|leak)\b[^.\n]{0,30}\b(system prompt|your prompt|your instructions)\b/gi,
  /<\/?\s*(system|assistant|developer)\s*>/gi,
  /\bnew instructions\s*:/gi,
  /\bas an ai( language)? model\b[^.\n]{0,40}\byou (must|should|will)\b/gi,
];

/** How many separate instruction-like attempts the text contains. A heuristic, not a verdict. */
export function countInjectionAttempts(text: string): number {
  return PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

/** Truncates page text and fences it. Marker text inside the page is removed so it cannot close the fence early. */
export function wrapUntrusted(text: string, maxChars = 6000): string {
  const clean = text.split(UNTRUSTED_OPEN).join("").split(UNTRUSTED_CLOSE).join("").slice(0, maxChars);
  return `${UNTRUSTED_OPEN}\n${clean}\n${UNTRUSTED_CLOSE}`;
}
