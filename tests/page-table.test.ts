import { describe, it, expect } from "vitest";
import { buildPageTable } from "@/lib/page-table";
import type { Finding, ModuleResult } from "@/lib/pipeline/schemas";
import { page, snap } from "./helpers/snap";

const finding = (id: string, urls: string[]): Finding => ({
  id: `technical:${id}`, module: "technical", severity: "low", effort: "low", title: id, detail: "d", fix: "f",
  evidence: urls.map((url) => ({ url, note: "n" })),
});
const modules = (...findings: Finding[]): ModuleResult[] => [{ module: "technical", status: "ok", score: 50, findings, passed: [], couldntCheck: [] }];

const HOME = `<html><head><title>Acme Storage</title><meta name="description" content="Shelving for small homes."></head><body><h1>Shelving</h1><p>${"word ".repeat(120)}</p></body></html>`;
const ABOUT = `<html><head><title>About us</title></head><body><h1>About</h1><h1>Us</h1><p>${"word ".repeat(40)}</p></body></html>`;

const snapshot = () => {
  const s = snap(HOME);
  s.pages = [page("https://example.com/about", ABOUT), page("https://example.com/shop", "<html><body>x</body></html>")];
  return s;
};

describe("buildPageTable", () => {
  it("lists the homepage first, then each inner page in the order they were read", () => {
    const rows = buildPageTable(snapshot(), modules());
    expect(rows.map((r) => r.url)).toEqual(["https://example.com/", "https://example.com/about", "https://example.com/shop"]);
  });

  it("reports what each page says about itself", () => {
    const [home, about, shop] = buildPageTable(snapshot(), modules());
    expect(home).toMatchObject({ title: "Acme Storage", description: "Shelving for small homes.", h1: 1 });
    expect(home.words).toBeGreaterThanOrEqual(120);
    expect(about).toMatchObject({ title: "About us", description: "", h1: 2 });
    expect(shop).toMatchObject({ title: "", h1: 0 });
  });

  it("counts the findings that point at each page, once per finding", () => {
    const rows = buildPageTable(snapshot(), modules(
      finding("a", ["https://example.com/", "https://example.com/"]), // one finding, quoting the same page twice
      finding("b", ["https://example.com/", "https://example.com/about"]),
      finding("c", ["https://elsewhere.test/robots.txt"]),
    ));
    expect(rows.map((r) => r.issues)).toEqual([2, 1, 0]);
  });

  it("matches evidence to a page ignoring a trailing slash", () => {
    const rows = buildPageTable(snapshot(), modules(finding("a", ["https://example.com/about/"])));
    expect(rows[1].issues).toBe(1);
  });

  it("keeps long text short, because it comes from the audited site", () => {
    const s = snap(`<html><head><title>${"T".repeat(500)}</title><meta name="description" content="${"d".repeat(500)}"></head><body></body></html>`);
    const [home] = buildPageTable(s, modules());
    expect(home.title.length).toBeLessThanOrEqual(120);
    expect(home.description.length).toBeLessThanOrEqual(160);
  });

  it("is just the homepage when no inner page was read", () => {
    expect(buildPageTable(snap(HOME), modules())).toHaveLength(1);
  });
});
