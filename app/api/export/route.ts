import { NextRequest, NextResponse } from "next/server";

type ExportFormat = "csv" | "json" | "markdown" | "pdf";

type ArticlePreview = {
  title: string;
  subtitle: string;
  descriptor: string;
  url: string;
  publishedAt: string;
  author: string;
};

type AuthorContext = {
  canonicalUrl: URL;
  authorSlug: string;
  authorName: string;
};

type FetchPayload = {
  html: string;
  extraUrls: URL[];
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

const MAX_ARTICLES = 60;
const MAX_PAGES = 30;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { authorUrl?: string; format?: ExportFormat };
    const authorUrl = body.authorUrl?.trim();
    const format = body.format;

    if (!authorUrl || !format) {
      return NextResponse.json({ error: "Debes indicar URL y formato." }, { status: 400 });
    }

    const context = parseAndValidateAuthorUrl(authorUrl);
    const articles = await collectAuthorPreviews(context);

    if (articles.length === 0) {
      return NextResponse.json(
        { error: "No se han encontrado artículos en la página de autor indicada." },
        { status: 404 },
      );
    }

    const file = buildExport(articles, format);
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseAndValidateAuthorUrl(input: string): AuthorContext {
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

  const slugWithId = parsed.pathname.split("/autor/")[1]?.replace(/^\/+/, "") ?? "";
  const slugBase = slugWithId.replace(/\.html$/, "").replace(/-\d+$/, "");
  const authorName = slugBase
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

  return {
    canonicalUrl: parsed,
    authorSlug: normalizeText(slugBase),
    authorName,
  };
}

async function collectAuthorPreviews(context: AuthorContext): Promise<ArticlePreview[]> {
  const queue: string[] = seedAuthorUrls(context.canonicalUrl);
  const queued = new Set(queue);
  const visited = new Set<string>();
  const articlesByUrl = new Map<string, ArticlePreview>();

  while (queue.length > 0 && visited.size < MAX_PAGES && articlesByUrl.size < MAX_ARTICLES) {
    const pageUrl = queue.shift();
    if (!pageUrl || visited.has(pageUrl)) {
      continue;
    }

    visited.add(pageUrl);

    const payload = await fetchPayload(pageUrl, context.canonicalUrl);
    if (!payload) {
      continue;
    }

    const pageItems = extractArticlePreviewsFromAuthorHtml(payload.html, context);
    pageItems.forEach((item) => {
      if (!articlesByUrl.has(item.url) && articlesByUrl.size < MAX_ARTICLES) {
        articlesByUrl.set(item.url, item);
      }
    });

    const nextUrls = [
      ...discoverLoadMoreUrls(payload.html, context.canonicalUrl),
      ...discoverNextRelUrls(payload.html, context.canonicalUrl),
      ...payload.extraUrls,
    ];

    nextUrls.forEach((url) => {
      if (
        queue.length + visited.size < MAX_PAGES * 4 &&
        isPotentialAuthorPagination(url, context) &&
        !queued.has(url.toString())
      ) {
        queue.push(url.toString());
        queued.add(url.toString());
      }
    });
  }

  return [...articlesByUrl.values()].slice(0, MAX_ARTICLES);
}

function seedAuthorUrls(base: URL): string[] {
  const urls = new Set<string>([base.toString()]);

  for (let i = 2; i <= MAX_PAGES; i += 1) {
    urls.add(withPageParam(base, "page", i).toString());
    urls.add(withPageParam(base, "pagina", i).toString());
    urls.add(withPageParam(base, "_page", i).toString());
    urls.add(withPageParam(base, "offset", (i - 1) * 10).toString());
    urls.add(withPathPage(base, i).toString());
  }

  return [...urls];
}

function withPageParam(base: URL, param: string, value: number): URL {
  const next = new URL(base.toString());
  next.searchParams.set(param, String(value));
  return next;
}

function withPathPage(base: URL, page: number): URL {
  const next = new URL(base.toString());
  next.pathname = next.pathname.replace(/\.html$/, `/${page}.html`);
  return next;
}

async function fetchPayload(url: string, baseUrl: URL): Promise<FetchPayload | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VocentoArticleExporter/1.0)",
        Accept: "text/html,application/xhtml+xml,application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const text = await response.text();

    if (contentType.includes("application/json") || looksLikeJson(text)) {
      return extractFromJsonPayload(text, baseUrl);
    }

    return {
      html: text,
      extraUrls: [],
    };
  } catch {
    return null;
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function extractFromJsonPayload(jsonText: string, baseUrl: URL): FetchPayload {
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const htmlParts: string[] = [];
    const urls: URL[] = [];

    walkJson(parsed, (value) => {
      if (/<(article|div|li|section|a|time)\b/i.test(value)) {
        htmlParts.push(value);
      }
      if (/https?:\/\//i.test(value) || value.startsWith("/")) {
        const normalized = normalizeUrl(value, baseUrl);
        if (normalized) {
          urls.push(normalized);
        }
      }
    });

    return {
      html: htmlParts.join("\n"),
      extraUrls: urls,
    };
  } catch {
    return {
      html: "",
      extraUrls: [],
    };
  }
}

function walkJson(input: unknown, onString: (value: string) => void) {
  if (typeof input === "string") {
    onString(input);
    return;
  }

  if (Array.isArray(input)) {
    input.forEach((item) => walkJson(item, onString));
    return;
  }

  if (input && typeof input === "object") {
    Object.values(input).forEach((value) => walkJson(value, onString));
  }
}

function discoverLoadMoreUrls(html: string, baseUrl: URL): URL[] {
  const results = new Set<string>();
  const absoluteUrlRegex = /https?:\/\/[^"'\s<>()]+/gi;

  for (const match of html.matchAll(absoluteUrlRegex)) {
    const value = match[0];
    if (looksLikeLoadMoreUrl(value)) {
      results.add(value);
    }
  }

  const attrRegex = /(data-url|data-next|data-href|href|data-endpoint|data-api-url)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrRegex)) {
    const raw = match[2];
    const normalized = normalizeUrl(raw, baseUrl);
    if (normalized && looksLikeLoadMoreUrl(normalized.toString())) {
      results.add(normalized.toString());
    }
  }

  return [...results].map((value) => new URL(value, baseUrl));
}

function discoverNextRelUrls(html: string, baseUrl: URL): URL[] {
  const results: URL[] = [];
  const relNextRegex = /<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["'][^>]*>/gi;

  for (const match of html.matchAll(relNextRegex)) {
    const normalized = normalizeUrl(match[1], baseUrl);
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}

function looksLikeLoadMoreUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("autor") && (
    lower.includes("page=") ||
    lower.includes("pagina=") ||
    lower.includes("_page=") ||
    lower.includes("offset=") ||
    lower.includes("load") ||
    lower.includes("more") ||
    lower.includes("ajax") ||
    lower.includes("siguiente") ||
    lower.includes("next")
  );
}

function isPotentialAuthorPagination(url: URL, context: AuthorContext): boolean {
  if (!isSameVocentoFamilyHost(url.hostname)) {
    return false;
  }

  const path = url.pathname.toLowerCase();
  const authorPathBase = context.canonicalUrl.pathname.toLowerCase().replace(/\.html$/, "");

  return (
    path.includes("/autor/") &&
    (path.includes(authorPathBase) || normalizeText(path).includes(context.authorSlug))
  );
}

function extractArticlePreviewsFromAuthorHtml(html: string, context: AuthorContext): ArticlePreview[] {
  const articleBlocks = [...html.matchAll(/<article[\s\S]*?<\/article>/gi)].map((item) => item[0]);
  const cards = articleBlocks.length > 0 ? articleBlocks : extractFallbackCardBlocks(html);

  const previews: ArticlePreview[] = [];

  cards.forEach((card) => {
    const url = extractMainArticleLink(card, context.canonicalUrl);
    if (!url) {
      return;
    }

    const title =
      cleanHtml(extractTagContent(card, "h2") || extractTagContent(card, "h3") || extractTagContent(card, "h1")) ||
      cleanHtml(extractAnchorText(card)) ||
      "Sin titular";

    const subtitle = cleanHtml(extractByClass(card, ["subtitulo", "subtitle", "entradilla", "resumen"])) ||
      cleanHtml(extractFirstParagraph(card));

    const descriptor = cleanHtml(extractByClass(card, ["descriptor", "antetitulo", "kicker", "volanta"])) || "";
    const publishedAt = extractTimeDatetime(card) || cleanHtml(extractByClass(card, ["fecha", "date", "time"])) || "";

    if (!isSameVocentoFamilyHost(url.hostname)) {
      return;
    }

    if (!matchesAuthorContext(card, context) && !matchesAuthorContext(url.pathname, context)) {
      return;
    }

    previews.push({
      title,
      subtitle,
      descriptor,
      url: url.toString(),
      publishedAt,
      author: context.authorName,
    });
  });

  return previews;
}

function extractFallbackCardBlocks(html: string): string[] {
  const divCards = [...html.matchAll(/<div[^>]*class=["'][^"']*(noticia|news|story|item)[^"']*["'][\s\S]*?<\/div>/gi)]
    .map((item) => item[0]);
  return divCards.slice(0, 600);
}

function extractMainArticleLink(block: string, baseUrl: URL): URL | null {
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;

  for (const match of block.matchAll(hrefRegex)) {
    const normalized = normalizeUrl(match[1], baseUrl);
    if (
      normalized &&
      normalized.pathname.endsWith(".html") &&
      !normalized.pathname.includes("/autor/") &&
      !normalized.pathname.includes("/tag/") &&
      !normalized.pathname.includes("/servicios/")
    ) {
      return normalized;
    }
  }

  return null;
}

function matchesAuthorContext(value: string, context: AuthorContext): boolean {
  const normalized = normalizeText(cleanHtml(value));
  if (!normalized) {
    return true;
  }

  return normalized.includes(context.authorSlug) || context.authorSlug.includes(normalized);
}

function isSameVocentoFamilyHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./, "");
  return ALLOWED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function normalizeUrl(input: string, baseUrl: URL): URL | null {
  try {
    return new URL(input, baseUrl);
  } catch {
    return null;
  }
}

function extractByClass(html: string, classHints: string[]): string {
  for (const hint of classHints) {
    const regex = new RegExp(
      `<[^>]*class=["'][^"']*${escapeRegex(hint)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
      "i",
    );
    const match = regex.exec(html)?.[1];
    if (match) {
      return match;
    }
  }
  return "";
}

function extractTagContent(html: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return regex.exec(html)?.[1] ?? "";
}

function extractAnchorText(html: string): string {
  const regex = /<a[^>]*>([\s\S]*?)<\/a>/i;
  return regex.exec(html)?.[1] ?? "";
}

function extractFirstParagraph(html: string): string {
  const regex = /<p[^>]*>([\s\S]*?)<\/p>/i;
  return regex.exec(html)?.[1] ?? "";
}

function extractTimeDatetime(html: string): string {
  const regex = /<time[^>]*datetime=["']([^"']+)["'][^>]*>/i;
  return regex.exec(html)?.[1] ?? "";
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
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&uuml;/gi, "ü")
    .replace(/&Aacute;/g, "Á")
    .replace(/&Eacute;/g, "É")
    .replace(/&Iacute;/g, "Í")
    .replace(/&Oacute;/g, "Ó")
    .replace(/&Uacute;/g, "Ú")
    .replace(/&Ntilde;/g, "Ñ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExport(items: ArticlePreview[], format: ExportFormat) {
  if (format === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify(items, null, 2),
    };
  }

  if (format === "csv") {
    const headers = ["title", "subtitle", "descriptor", "url", "publishedAt", "author"];
    const rows = items.map((item) =>
      [item.title, item.subtitle, item.descriptor, item.url, item.publishedAt, item.author]
        .map((value) => `"${value.replaceAll('"', '""')}"`)
        .join(","),
    );

    return {
      contentType: "text/csv; charset=utf-8",
      content: [headers.join(","), ...rows].join("\n"),
    };
  }

  if (format === "markdown") {
    const content = items
      .map((item) => {
        const subtitle = item.subtitle ? `\n\n> ${item.subtitle}` : "";
        const descriptor = item.descriptor ? `\n- Descriptor: ${item.descriptor}` : "";
        return `# ${item.title}${subtitle}\n\n- URL: ${item.url}\n- Fecha: ${item.publishedAt || "N/D"}\n- Autor: ${item.author}${descriptor}`;
      })
      .join("\n\n---\n\n");

    return {
      contentType: "text/markdown; charset=utf-8",
      content,
    };
  }

  return {
    contentType: "application/pdf",
    content: createSimplePdf(items),
  };
}

function createSimplePdf(items: ArticlePreview[]): Uint8Array {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");

  const pageObjectIds: number[] = [];

  items.forEach((item, index) => {
    const contentObjectId = 3 + index * 2;
    const pageObjectId = contentObjectId + 1;
    pageObjectIds.push(pageObjectId);

    const lines = wrapText([
      item.title,
      item.subtitle,
      item.descriptor && `Descriptor: ${item.descriptor}`,
      `URL: ${item.url}`,
      `Fecha: ${item.publishedAt || "N/D"}`,
      `Autor: ${item.author}`,
    ].filter(Boolean).join("\n\n"), 95);

    const streamBody = ["BT", "/F1 10 Tf", "36 806 Td", "14 TL"]
      .concat(lines.map((line, lineIndex) => `${lineIndex === 0 ? "" : "T* "}(${escapePdfText(line)}) Tj`))
      .concat(["ET"])
      .join("\n");

    objects[contentObjectId - 1] = `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`;
    objects[pageObjectId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
  });

  objects[1] = `<< /Type /Pages /Count ${items.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  const header = "%PDF-1.4\n";
  let output = header;
  const xref: number[] = [0];

  objects.forEach((objectBody, i) => {
    const objectId = i + 1;
    xref.push(toLatin1Bytes(output).length);
    output += `${objectId} 0 obj\n${objectBody}\nendobj\n`;
  });

  const xrefStart = toLatin1Bytes(output).length;
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";

  xref.slice(1).forEach((offset) => {
    output += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  });

  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return toLatin1Bytes(output);
}

function escapePdfText(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\xFF]/g, "?");
}

function toLatin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
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
    .slice(0, 160);
}
