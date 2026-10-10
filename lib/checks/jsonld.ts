import type * as cheerio from "cheerio";

export interface JsonLdBlock {
  /** Position of the block on the page, from 1. */
  index: number;
  /** The text of the block as it appears on the page. */
  raw: string;
  /** The parsed JSON, or null when the block is broken. */
  data: unknown | null;
  /** Why the block did not parse. */
  error?: string;
}

/** Every JSON-LD block on the page. A broken block is kept, with the reason, so it can be reported. */
export function readJsonLd($: cheerio.CheerioAPI): JsonLdBlock[] {
  const blocks: JsonLdBlock[] = [];
  $('script[type="application/ld+json" i]').each((i, el) => {
    const raw = $(el).text();
    if (raw.trim() === "") {
      blocks.push({ index: i + 1, raw, data: null, error: "the block is empty" });
      return;
    }
    try {
      blocks.push({ index: i + 1, raw, data: JSON.parse(raw) });
    } catch (err) {
      blocks.push({ index: i + 1, raw, data: null, error: err instanceof Error ? err.message : "the block is not valid JSON" });
    }
  });
  return blocks;
}

/** Every node, at any depth, whose @type is one of `types`. Nesting is capped, so hostile input cannot loop. */
export function nodesOfType(blocks: JsonLdBlock[], types: Set<string>): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 10 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1));
    const record = node as Record<string, unknown>;
    const raw = record["@type"];
    if ((Array.isArray(raw) ? raw : [raw]).some((t) => typeof t === "string" && types.has(t))) found.push(record);
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  for (const b of blocks) if (b.data !== null) walk(b.data, 0);
  return found;
}

export interface SchemaProblem {
  kind: "missing" | "placeholder";
  /** The schema.org type the problem is in. */
  type: string;
  property?: string;
  /** The offending text, for a placeholder. */
  text?: string;
}

// Types Google and AI systems treat as a business at one place. These need an address to be useful.
const LOCAL_BUSINESS = new Set([
  "LocalBusiness", "Store", "Restaurant", "Bakery", "CafeOrCoffeeShop", "FoodEstablishment", "BarOrPub", "Hotel", "LodgingBusiness",
  "MedicalClinic", "Dentist", "Physician", "LegalService", "Attorney", "RealEstateAgent", "AutomotiveBusiness", "AutoRepair",
  "HealthAndBeautyBusiness", "HairSalon", "BeautySalon", "ProfessionalService", "FinancialService", "AccountingService",
  "HomeAndConstructionBusiness", "Plumber", "Electrician", "GymOrHealthClub", "ChildCare", "TravelAgency", "EntertainmentBusiness",
]);
const ORGANISATION = new Set(["Organization", "Corporation", "NGO", "OnlineStore", "OnlineBusiness", "EducationalOrganization", "MedicalOrganization"]);
const ARTICLE = new Set(["Article", "BlogPosting", "NewsArticle"]);

// Text a template or a plugin leaves behind when it was never filled in. Case matters for the
// markers: "Todo Cafe" is a business name, "TODO" is a note to self.
const PLACEHOLDERS: RegExp[] = [
  // A bracket only counts when it looks like a fill-in field, so "[sic]" or "[1]" are left alone.
  /\[[^\]]{0,40}(business|company|brand|site|your|insert|enter|name|address|phone|url|email)[^\]]{0,40}\]/i,
  /lorem ipsum/i,
  /\byour (business|company|site|website|brand|name)\b/i,
  /yourdomain|your-domain|yoursite|yourwebsite/i,
  /\b(TODO|FIXME|REPLACE ME|CHANGE ME)\b/,
];

const isPlaceholder = (text: string): boolean => PLACEHOLDERS.some((re) => re.test(text));

const present = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
};

const MAX_DEPTH = 10;

/** Missing required properties and leftover placeholder text in the blocks that parsed. */
export function schemaProblems(blocks: JsonLdBlock[]): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const seen = new Set<string>();
  const add = (p: SchemaProblem) => {
    const key = `${p.kind}|${p.type}|${p.property ?? ""}|${p.text ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(p);
    }
  };

  const walk = (node: unknown, depth: number, type: string): void => {
    if (depth > MAX_DEPTH || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (isPlaceholder(node)) add({ kind: "placeholder", type: type || "structured data", text: node.slice(0, 80) });
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1, type));

    const record = node as Record<string, unknown>;
    const rawTypes = record["@type"];
    const types = (Array.isArray(rawTypes) ? rawTypes : [rawTypes]).filter((t): t is string => typeof t === "string");
    const keys = Object.keys(record).filter((k) => k !== "@type" && k !== "@context");
    // {"@id": "..."} on its own only points at a node described elsewhere, so there is nothing to check.
    const isReference = keys.length === 1 && keys[0] === "@id";

    if (!isReference) {
      const need = (t: string, property: string) => {
        if (!present(record[property])) add({ kind: "missing", type: t, property });
      };
      const local = types.find((t) => LOCAL_BUSINESS.has(t));
      const org = types.find((t) => ORGANISATION.has(t));
      if (local) {
        need(local, "name");
        need(local, "address");
      } else if (org) {
        need(org, "name");
      }
      const article = types.find((t) => ARTICLE.has(t));
      if (article) need(article, "headline");
      if (types.includes("Product")) need("Product", "name");
      if (types.includes("FAQPage")) need("FAQPage", "mainEntity");
    }

    const here = types[0] ?? type;
    for (const [key, value] of Object.entries(record)) {
      if (key === "@context" || key === "@id") continue;
      walk(value, depth + 1, here);
    }
  };

  for (const b of blocks) if (b.data !== null) walk(b.data, 0, "");
  return problems;
}
