import { NextResponse } from "next/server";
import { trackVisit } from "@/lib/exportMetrics";

export async function POST() {
  await trackVisit();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
