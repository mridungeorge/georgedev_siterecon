import { getDb } from "@/lib/db";
import { getReport } from "@/lib/report-store";
import { corsHeaders } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const headers = { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) };
  const report = /^[\w-]{1,64}$/.test(id) ? getReport(getDb(), id) : null;
  if (!report) return new Response(JSON.stringify({ error: "Report not found. Reports are kept for 30 days." }), { status: 404, headers });
  return new Response(JSON.stringify(report), { headers });
}
