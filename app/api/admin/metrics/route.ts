import { NextRequest, NextResponse } from "next/server";
import { getExportMetricsSnapshot } from "@/lib/exportMetrics";

function isAuthorized(request: NextRequest): boolean {
  const configuredKey = process.env.ADMIN_DASHBOARD_KEY;
  if (!configuredKey) {
    return false;
  }

  const receivedKey =
    request.headers.get("x-admin-key") ??
    request.nextUrl.searchParams.get("key") ??
    "";

  return receivedKey === configuredKey;
}

export async function GET(request: NextRequest) {
  if (!process.env.ADMIN_DASHBOARD_KEY) {
    return NextResponse.json(
      { error: "Falta configurar ADMIN_DASHBOARD_KEY en el entorno." },
      { status: 503 },
    );
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const snapshot = await getExportMetricsSnapshot();
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}
