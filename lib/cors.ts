// Same approach as RepoRecon's lib/cors.ts: an origin allowlist, never a wildcard,
// because every request to this API costs real compute and free-tier quota.
const ALLOWED_ORIGINS = new Set([
  "https://georgemridun.dev",
  "https://www.georgemridun.dev",
  "http://localhost:3100", // portfolio local dev
]);

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}
