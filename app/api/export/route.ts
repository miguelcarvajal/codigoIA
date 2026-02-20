import { NextRequest, NextResponse } from "next/server";

type ExportFormat = "csv" | "json" | "markdown" | "pdf";

type Article = {
  title: string;
  url: string;
  publishedAt: string;
  author: string;
  content: string;
};

const ALLOWED_DOMAINS = [
  "colpisa.com",
  "elcorreo.com",
  "diariovasco.com",
  "ideal.es",
  "elcomercio.es",
  "leonoticias.com",
  "eldiariomontanes.es",
  "hoy.es",
  "diariolarioja.com",
  "laverdad.es",
];

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { authorUrl?: string; format?: ExportFormat };
    const authorUrl = body.authorUrl?.trim();
    const format = body.format;

    if (!authorUrl || !format) {
      return NextResponse.json({ error: "Debes indicar URL y formato." }, { status: 400 });
    }

    const parsedUrl = parseAndValidateAuthorUrl(authorUrl);
    const authorPage = await fetchText(parsedUrl.toString());
    const articleUrls = extractArticleUrls(authorPage, parsedUrl).slice(0, 60);

    if (articleUrls.length === 0) {
      return NextResponse.json({ error: "No se han encontrado artículos para esta autora o autor." }, { status: 404 });
    }

    const articles = (await Promise.all(articleUrls.map((url) => scrapeArticle(url, parsedUrl.hostname)))).filter(
      (article): article is Article => Boolean(article),
    );

    if (articles.length === 0) {
      return NextResponse.json({ error: "No se ha podido extraer contenido de los artículos." }, { status: 422 });
    }

    const file = buildExport(articles, format);
    const extension = format === "markdown" ? "md" : format;

    const payload = typeof file.content === "string"
      ? file.content
      : new Blob([file.content], { type: file.contentType });

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

function parseAndValidateAuthorUrl(input: string): URL {
  const parsed = new URL(input);
  const normalizedHost = parsed.hostname.replace(/^www\./, "");

  const isAllowed = ALLOWED_DOMAINS.some(
    (domain) => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`),
  );

  if (!isAllowed) {
    throw new Error("Solo se admiten URLs de diarios del grupo Vocento.");
  }

  if (!parsed.pathname.includes("/autor/")) {
    throw new Error("La URL debe ser una página de autor (ruta /autor/...).");
  }

  return parsed;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; VocentoArticleExporter/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`No se pudo abrir ${url}. Estado: ${response.status}`);
  }

  return response.text();
}

function extractArticleUrls(html: string, baseUrl: URL): string[] {
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  const results = new Set<string>();

  let match: RegExpExecArray | null = hrefRegex.exec(html);
  while (match) {
    const href = match[1];
    const normalized = normalizeUrl(href, baseUrl);

    if (
      normalized &&
      normalized.pathname.endsWith(".html") &&
      !normalized.pathname.includes("/autor/") &&
      !normalized.pathname.includes("/tag/") &&
      !normalized.pathname.includes("/servicios/")
    ) {
      const host = normalized.hostname.replace(/^www\./, "");
      if (ALLOWED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        results.add(normalized.toString());
      }
    }

    match = hrefRegex.exec(html);
  }

  return [...results];
}

function normalizeUrl(input: string, baseUrl: URL): URL | null {
  try {
    return new URL(input, baseUrl);
  } catch {
    return null;
  }
}

async function scrapeArticle(url: string, fallbackAuthor: string): Promise<Article | null> {
  try {
    const html = await fetchText(url);
    const title =
      extractMetaContent(html, "property", "og:title") ||
      extractTagContent(html, "title") ||
      "Sin título";

    const publishedAt =
      extractMetaContent(html, "property", "article:published_time") ||
      extractMetaContent(html, "name", "date") ||
      extractTimeDatetime(html) ||
      "";

    const author =
      extractMetaContent(html, "name", "author") ||
      extractMetaContent(html, "property", "article:author") ||
      fallbackAuthor;

    const articleBlock = extractTagBlock(html, "article") ?? html;
    const paragraphs = [...articleBlock.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((item) => cleanHtml(item[1]))
      .filter((text) => text.length > 30);

    const content = paragraphs.join("\n\n").trim();

    if (!content) {
      return null;
    }

    return {
      title: cleanHtml(title),
      url,
      publishedAt,
      author: cleanHtml(author),
      content,
    };
  } catch {
    return null;
  }
}

function extractMetaContent(html: string, attr: "name" | "property", value: string): string | null {
  const regex = new RegExp(
    `<meta[^>]*${attr}=["']${escapeRegex(value)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const reverseRegex = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${escapeRegex(value)}["'][^>]*>`,
    "i",
  );

  return regex.exec(html)?.[1] ?? reverseRegex.exec(html)?.[1] ?? null;
}

function extractTagContent(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return regex.exec(html)?.[1] ?? null;
}

function extractTimeDatetime(html: string): string | null {
  const regex = /<time[^>]*datetime=["']([^"']+)["'][^>]*>/i;
  return regex.exec(html)?.[1] ?? null;
}

function extractTagBlock(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return regex.exec(html)?.[1] ?? null;
}

function cleanHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExport(articles: Article[], format: ExportFormat) {
  if (format === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify(articles, null, 2),
    };
  }

  if (format === "csv") {
    const headers = ["title", "url", "publishedAt", "author", "content"];
    const rows = articles.map((article) =>
      [article.title, article.url, article.publishedAt, article.author, article.content]
        .map((value) => `"${value.replaceAll('"', '""')}"`)
        .join(","),
    );

    return {
      contentType: "text/csv; charset=utf-8",
      content: [headers.join(","), ...rows].join("\n"),
    };
  }

  if (format === "markdown") {
    const content = articles
      .map(
        (article) =>
          `# ${article.title}\n\n- URL: ${article.url}\n- Fecha: ${article.publishedAt || "N/D"}\n- Autor: ${article.author}\n\n${article.content}`,
      )
      .join("\n\n---\n\n");

    return {
      contentType: "text/markdown; charset=utf-8",
      content,
    };
  }

  const pages = articles.map(
    (article) =>
      `${article.title}\n\nURL: ${article.url}\nFecha: ${article.publishedAt || "N/D"}\nAutor: ${article.author}\n\n${article.content}`,
  );

  return {
    contentType: "application/pdf",
    content: createSimplePdf(pages),
  };
}

function createSimplePdf(pages: string[]): ArrayBuffer {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");

  const pageObjectIds: number[] = [];

  pages.forEach((pageText, index) => {
    const contentObjectId = 3 + index * 2;
    const pageObjectId = contentObjectId + 1;
    pageObjectIds.push(pageObjectId);

    const safeText = escapePdfText(pageText);
    const lines = wrapText(safeText, 95);

    const streamBody = ["BT", "/F1 10 Tf", "36 806 Td", "14 TL"]
      .concat(lines.map((line, lineIndex) => `${lineIndex === 0 ? "" : "T* "}(${line}) Tj`))
      .concat(["ET"])
      .join("\n");

    objects[contentObjectId - 1] = `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`;
    objects[pageObjectId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
  });

  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  const header = "%PDF-1.4\n";
  let output = header;
  const xref: number[] = [0];

  objects.forEach((objectBody, i) => {
    const objectId = i + 1;
    xref.push(output.length);
    output += `${objectId} 0 obj\n${objectBody}\nendobj\n`;
  });

  const xrefStart = output.length;
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";

  xref.slice(1).forEach((offset) => {
    output += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  });

  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(output).buffer;
}

function escapePdfText(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(text: string, maxChars: number): string[] {
  return text
    .split("\n")
    .flatMap((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        return [""];
      }

      const lines: string[] = [];
      let current = "";

      words.forEach((word) => {
        const next = current ? `${current} ${word}` : word;
        if (next.length > maxChars) {
          if (current) {
            lines.push(current);
          }
          current = word;
        } else {
          current = next;
        }
      });

      if (current) {
        lines.push(current);
      }

      return lines;
    })
    .slice(0, 240);
}
