import * as cheerio from "cheerio";
import type { SafeResponse } from "@/lib/safe-fetch";

export interface PageFacts {
  url: string;
  title: string;
  description: string;
  /** How many H1 headings the page has. */
  h1: number;
  /** The text of the first H1, or an empty string. */
  h1Text: string;
  /** Words of visible text. */
  words: number;
}

/** What one page says about itself: its title, description, headings and length. */
export function pageFacts(res: SafeResponse): PageFacts {
  const $ = cheerio.load(res.body);
  const title = $("head > title").first().text().replace(/\s+/g, " ").trim();
  const description = ($('meta[name="description" i]').attr("content") ?? "").replace(/\s+/g, " ").trim();
  const h1 = $("h1").length;
  const h1Text = $("h1").first().text().replace(/\s+/g, " ").trim();
  $("script, style, noscript, template, svg").remove();
  const words = $("body").text().split(/\s+/).filter(Boolean).length;
  return { url: res.finalUrl, title, description, h1, h1Text, words };
}
