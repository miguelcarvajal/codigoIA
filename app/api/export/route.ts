import { NextRequest, NextResponse } from "next/server";
import {
  buildExport,
  collectAuthorPreviews,
  enrichArticles,
  parseAndValidateAuthorUrl,
  toArrayBuffer,
  type ExportFormat,
} from "@/lib/authorProfile";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { authorUrl?: string; format?: ExportFormat };
    const authorUrl = body.authorUrl?.trim();
    const format = body.format;

    if (!authorUrl || !format) {
      return NextResponse.json({ error: "Debes indicar URL y formato." }, { status: 400 });
    }

    const context = parseAndValidateAuthorUrl(authorUrl);
    const baseArticles = await collectAuthorPreviews(context);
    const enrichedArticles = await enrichArticles(baseArticles, context.authorName, context);

    if (enrichedArticles.length === 0) {
      return NextResponse.json(
        { error: "No se han encontrado artículos en la página de autor indicada." },
        { status: 404 },
      );
    }

    const file = buildExport(enrichedArticles, format);
    const extension = format === "markdown" ? "md" : format;

    const payload = typeof file.content === "string"
      ? file.content
      : new Blob([toArrayBuffer(file.content)], { type: file.contentType });

    return new NextResponse(payload, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="articulos-vocento.${extension}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
