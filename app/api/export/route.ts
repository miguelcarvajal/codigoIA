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
  authorId: string;
};

type FetchPayload = {
  html: string;
  extraUrls: URL[];
};

type JsonLdArticle = {
  headline?: string;
  name?: string;
  description?: string;
  articleSection?: string;
  datePublished?: string;
  author?: unknown;
};

const ALLOWED_DOMAINS = [
  "abc.es",
  "colpisa.com",
  "elcorreo.com",
  "diariovasco.com",
  "eldiariomontanes.es",
  "laverdad.es",
  "ideal.es",
  "hoy.es",
  "diariosur.es",
  "larioja.com",
  "elnortedecastilla.es",
  "elcomercio.es",
  "lasprovincias.es",
  "lavozdigital.es",
  "burgosconecta.es",
  "leonoticias.com",
  "elbierzonoticias.com",
  "salamancahoy.es",
  "todoalicante.es",
  "huelva24.com",
];

const MAX_ARTICLES = 60;
const MAX_PAGES = 40;
const ENRICH_CONCURRENCY = 6;

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
  const slugWithoutExt = slugWithId.replace(/\.html$/, "");
  const authorId = /-(\d+)$/.exec(slugWithoutExt)?.[1] ?? "";
  const slugBase = slugWithoutExt.replace(/-\d+$/, "");
  const authorName = slugBase
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

  return {
    canonicalUrl: parsed,
    authorSlug: normalizeText(slugBase),
    authorName,
    authorId,
  };
}

async function collectAuthorPreviews(context: AuthorContext): Promise<ArticlePreview[]> {
  const queue: string[] = seedAuthorUrls(context.canonicalUrl, context);
  const queued = new Set(queue);
  const visited = new Set<string>();
  const articleMap = new Map<string, ArticlePreview>();
  const feedUrls = new Set<string>();

  while (queue.length > 0 && visited.size < MAX_PAGES && articleMap.size < MAX_ARTICLES) {
    const next = queue.shift();
    if (!next || visited.has(next)) {
      continue;
    }

    visited.add(next);

    const payload = await fetchPayload(next, context.canonicalUrl);
    if (!payload || !payload.html) {
      continue;
    }

    const fromCards = extractArticlePreviewsFromAuthorHtml(payload.html, context);
    const fromLinks = extractArticleLinksAsPreviews(payload.html, context);

    [...fromCards, ...fromLinks].forEach((item) => {
      if (!articleMap.has(item.url) && articleMap.size < MAX_ARTICLES) {
        articleMap.set(item.url, item);
      }
    });

    discoverFeedUrls(payload.html, context.canonicalUrl).forEach((feed) => feedUrls.add(feed.toString()));

    const nextUrls = [
      ...discoverLoadMoreUrls(payload.html, context.canonicalUrl),
      ...discoverAuthorButtonUrls(payload.html, context),
      ...discoverScriptPaginationUrls(payload.html, context.canonicalUrl, context),
      ...discoverNextRelUrls(payload.html, context.canonicalUrl),
      ...payload.extraUrls,
    ];

    nextUrls.forEach((url) => {
      const value = url.toString();
      if (
        !queued.has(value) &&
        queue.length + visited.size < MAX_PAGES * 6 &&
        isPotentialAuthorPagination(url, context)
      ) {
        queue.push(value);
        queued.add(value);
      }
    });
  }

  for (const feed of feedUrls) {
    if (articleMap.size >= MAX_ARTICLES) {
      break;
    }
    const payload = await fetchPayload(feed, context.canonicalUrl);
    if (!payload || !payload.html) {
      continue;
    }

    const rssItems = extractRssItems(payload.html, context.authorName, context.canonicalUrl);
    rssItems.forEach((item) => {
      if (!articleMap.has(item.url) && articleMap.size < MAX_ARTICLES) {
        articleMap.set(item.url, item);
      }
    });
  }

  return [...articleMap.values()].slice(0, MAX_ARTICLES);
}

function seedAuthorUrls(base: URL, context?: AuthorContext): string[] {
  const urls = new Set<string>([base.toString()]);

  for (let i = 2; i <= MAX_PAGES; i += 1) {
    urls.add(withPageParam(base, "page", i).toString());
    urls.add(withPageParam(base, "pagina", i).toString());
    urls.add(withPageParam(base, "_page", i).toString());
    urls.add(withPageParam(base, "offset", (i - 1) * 10).toString());
    urls.add(withPathPage(base, i).toString());
    urls.add(withPaginaPath(base, i).toString());
  }

  if (context?.authorId) {
    urls.add(new URL(`/rss/2.0/?author=${context.authorId}`, base).toString());
    urls.add(new URL(`/rss/2.0/?autor=${context.authorId}`, base).toString());
    urls.add(new URL(`/rss/2.0/?writer=${context.authorId}`, base).toString());
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

function withPaginaPath(base: URL, page: number): URL {
  const next = new URL(base.toString());
  next.pathname = next.pathname.replace(/\.html$/, `/pagina-${page}.html`);
  return next;
}

async function fetchPayload(url: string, baseUrl: URL): Promise<FetchPayload | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VocentoArticleExporter/1.0)",
        Accept: "text/html,application/xhtml+xml,application/xml,application/json",
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

    return { html: text, extraUrls: [] };
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
    return { html: "", extraUrls: [] };
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
    const normalized = normalizeUrl(match[2], baseUrl);
    if (normalized && looksLikeLoadMoreUrl(normalized.toString())) {
      results.add(normalized.toString());
    }
  }

  return [...results].map((value) => new URL(value, baseUrl));
}



function discoverAuthorButtonUrls(html: string, context: AuthorContext): URL[] {
  const results = new Set<string>();
  const buttonRegex = /<a[^>]*data-voc-show-news[^>]*>/gi;

  for (const m of html.matchAll(buttonRegex)) {
    const tag = m[0];
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const dataPage = /data-page=["']([0-9]{1,3})["']/i.exec(tag)?.[1];
    const dataId = /data-journalists-id=["']([^"']+)["']/i.exec(tag)?.[1];
    const dataName = /data-journalists-name=["']([^"']+)["']/i.exec(tag)?.[1];

    if (href) {
      const normalized = normalizeUrl(href, context.canonicalUrl);
      if (normalized && isPotentialAuthorPagination(normalized, context)) {
        results.add(normalized.toString());
      }
    }

    if (dataPage) {
      const n = Number(dataPage);
      if (Number.isFinite(n) && n > 1) {
        results.add(withPaginaPath(context.canonicalUrl, n).toString());
      }
    }

    if ((dataId && context.authorId && dataId === context.authorId) || (dataName && normalizeText(dataName) === context.authorSlug)) {
      for (let i = 2; i <= MAX_PAGES; i += 1) {
        results.add(withPaginaPath(context.canonicalUrl, i).toString());
      }
    }
  }

  return [...results].map((value) => new URL(value, context.canonicalUrl));
}

function discoverScriptPaginationUrls(html: string, baseUrl: URL, context: AuthorContext): URL[] {
  const results = new Set<string>();
  const scriptBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

  scriptBlocks.forEach((block) => {
    const decoded = block.replace(/\\\//g, "/");

    for (const m of decoded.matchAll(/https?:\/\/[^"'\s<>()]+/gi)) {
      if (looksLikeLoadMoreUrl(m[0])) {
        results.add(m[0]);
      }
    }

    for (const m of decoded.matchAll(/(["'])(\/[^"']*\/autor\/[^"']+)\1/gi)) {
      const normalized = normalizeUrl(m[2], baseUrl);
      if (normalized && isPotentialAuthorPagination(normalized, context)) {
        results.add(normalized.toString());
      }
    }

    const pageHint = /(?:page|pagina|_page|offset)\s*[:=]\s*([0-9]{1,3})/i.exec(decoded)?.[1];
    if (pageHint) {
      const n = Number(pageHint);
      if (Number.isFinite(n) && n > 1 && n <= MAX_PAGES * 3) {
        results.add(withPageParam(baseUrl, "page", n).toString());
        results.add(withPageParam(baseUrl, "pagina", n).toString());
        results.add(withPageParam(baseUrl, "_page", n).toString());
      }
    }
  });

  return [...results].map((value) => new URL(value, baseUrl));
}

function extractArticleLinksAsPreviews(html: string, context: AuthorContext): ArticlePreview[] {
  const out: ArticlePreview[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/<a[^>]*href=["']([^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = normalizeUrl(m[1], context.canonicalUrl);
    if (!url || seen.has(url.toString())) {
      continue;
    }

    if (!isSameVocentoFamilyHost(url.hostname) || url.pathname.includes("/autor/") || !looksLikeArticlePath(url.pathname)) {
      continue;
    }

    const title = cleanHtml(m[2]);
    if (!title || title.length < 12) {
      continue;
    }

    out.push({
      title,
      subtitle: "",
      descriptor: "",
      url: url.toString(),
      publishedAt: "",
      author: context.authorName,
    });
    seen.add(url.toString());
  }

  return out;
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

function discoverFeedUrls(html: string, baseUrl: URL): URL[] {
  const results = new Set<string>();
  const feedRegex = /<link[^>]*(type=["']application\/(rss\+xml|atom\+xml)["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*type=["']application\/(rss\+xml|atom\+xml)["'])[^>]*>/gi;

  for (const match of html.matchAll(feedRegex)) {
    const raw = match[3] ?? match[4];
    if (!raw) {
      continue;
    }
    const normalized = normalizeUrl(raw, baseUrl);
    if (normalized) {
      results.add(normalized.toString());
    }
  }

  const rawUrls = [...html.matchAll(/https?:\/\/[^"'\s<>()]+/gi)].map((m) => m[0]);
  rawUrls.forEach((url) => {
    const lower = url.toLowerCase();
    if (lower.includes("rss") || lower.includes("feed") || lower.endsWith(".xml")) {
      results.add(url);
    }
  });

  return [...results].map((value) => new URL(value, baseUrl));
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
  const authorPath = context.canonicalUrl.pathname.toLowerCase().replace(/\.html$/, "");

  return path.includes("/autor/") && (path.includes(authorPath) || normalizeText(path).includes(context.authorSlug));
}

function extractArticlePreviewsFromAuthorHtml(html: string, context: AuthorContext): ArticlePreview[] {
  const blocks = [...html.matchAll(/<article[\s\S]*?<\/article>/gi)].map((m) => m[0]);
  const cards = blocks.length > 0 ? blocks : extractFallbackCardBlocks(html);

  const previews: ArticlePreview[] = [];

  cards.forEach((card) => {
    const url = extractMainArticleLink(card, context.canonicalUrl);
    if (!url || !isSameVocentoFamilyHost(url.hostname) || !looksLikeArticlePath(url.pathname)) {
      return;
    }

    const title =
      cleanHtml(extractTagContent(card, "h2") || extractTagContent(card, "h3") || extractTagContent(card, "h1")) ||
      cleanHtml(extractAnchorText(card)) ||
      "Sin titular";

    const subtitle = cleanHtml(extractByClass(card, ["subtitulo", "subtitle", "entradilla", "resumen"])) ||
      cleanHtml(extractFirstParagraph(card));

    const descriptor = cleanHtml(extractByClass(card, ["descriptor", "antetitulo", "kicker", "volanta", "seccion"])) || "";
    const publishedAt = extractTimeDatetime(card) || cleanHtml(extractByClass(card, ["fecha", "date", "time"])) || "";
    const author = cleanHtml(extractByClass(card, ["author", "autor", "firma"])) || context.authorName;

    previews.push({
      title,
      subtitle,
      descriptor,
      url: url.toString(),
      publishedAt,
      author,
    });
  });

  return previews;
}

function extractRssItems(xml: string, fallbackAuthor: string, baseUrl: URL): ArticlePreview[] {
  const itemRegex = /<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi;
  const out: ArticlePreview[] = [];

  for (const match of xml.matchAll(itemRegex)) {
    const block = match[0];
    const rawUrl = extractXmlTag(block, "link") || /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] || "";
    const normalized = normalizeUrl(rawUrl, baseUrl);

    if (!normalized || !normalized.pathname.endsWith(".html") || !isSameVocentoFamilyHost(normalized.hostname) || !looksLikeArticlePath(normalized.pathname)) {
      continue;
    }

    out.push({
      title: cleanHtml(extractXmlTag(block, "title")) || "Sin titular",
      subtitle: cleanHtml(extractXmlTag(block, "description") || extractXmlTag(block, "summary")),
      descriptor: cleanHtml(extractXmlTag(block, "category")),
      url: normalized.toString(),
      publishedAt: cleanHtml(extractXmlTag(block, "pubDate") || extractXmlTag(block, "updated") || extractXmlTag(block, "published")),
      author: cleanHtml(extractXmlTag(block, "author") || extractXmlTag(block, "dc:creator")) || fallbackAuthor,
    });
  }

  return out;
}

async function enrichArticles(items: ArticlePreview[], fallbackAuthor: string, context?: AuthorContext): Promise<ArticlePreview[]> {
  const limited = items.slice(0, MAX_ARTICLES);
  const result: ArticlePreview[] = [];

  for (let i = 0; i < limited.length; i += ENRICH_CONCURRENCY) {
    const chunk = limited.slice(i, i + ENRICH_CONCURRENCY);
    const enriched = await Promise.all(chunk.map(async (item) => enrichOneArticle(item, fallbackAuthor, context)));
    enriched.forEach((item) => {
      if (item) {
        result.push(item);
      }
    });
  }

  return result;
}

async function enrichOneArticle(item: ArticlePreview, fallbackAuthor: string, context?: AuthorContext): Promise<ArticlePreview | null> {
  const payload = await fetchPayload(item.url, new URL(item.url));
  if (!payload || !payload.html) {
    return item;
  }

  const html = payload.html;
  const jsonLd = extractNewsArticleFromJsonLd(html);

  const title =
    jsonLd.title ||
    cleanHtml(extractMetaContent(html, "property", "og:title")) ||
    cleanHtml(extractTagContent(html, "h1")) ||
    cleanHtml(extractTagContent(html, "title")) ||
    item.title;

  const subtitle =
    jsonLd.subtitle ||
    cleanHtml(extractMetaContent(html, "property", "og:description")) ||
    cleanHtml(extractMetaContent(html, "name", "description")) ||
    cleanHtml(extractByClass(html, ["subtitulo", "subtitle", "entradilla", "resumen"])) ||
    item.subtitle;

  const descriptor =
    jsonLd.descriptor ||
    cleanHtml(extractMetaContent(html, "property", "article:section")) ||
    cleanHtml(extractByClass(html, ["descriptor", "antetitulo", "kicker", "volanta", "seccion"])) ||
    item.descriptor;

  const publishedAt =
    jsonLd.publishedAt ||
    cleanHtml(extractMetaContent(html, "property", "article:published_time")) ||
    extractTimeDatetime(html) ||
    item.publishedAt;

  const author =
    jsonLd.author ||
    cleanHtml(extractMetaContent(html, "name", "author")) ||
    cleanHtml(extractMetaContent(html, "property", "article:author")) ||
    cleanHtml(extractByClass(html, ["author", "autor", "firma"])) ||
    item.author || fallbackAuthor;

  const normalizedAuthor = normalizeText(author);
  if (context && normalizedAuthor && normalizedAuthor !== context.authorSlug && !normalizedAuthor.includes(context.authorSlug) && !context.authorSlug.includes(normalizedAuthor)) {
    return null;
  }

  return {
    ...item,
    title,
    subtitle,
    descriptor,
    publishedAt,
    author,
  };
}


function extractNewsArticleFromJsonLd(html: string): Partial<ArticlePreview> {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter(Boolean);

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block) as unknown;
      const candidate = findNewsArticleNode(parsed);
      if (!candidate) {
        continue;
      }

      const article = candidate as JsonLdArticle;
      const title = cleanHtml(String(article.headline ?? article.name ?? ""));
      const subtitle = cleanHtml(String(article.description ?? ""));
      const descriptor = cleanHtml(String(article.articleSection ?? ""));
      const publishedAt = cleanHtml(String(article.datePublished ?? ""));
      const author = cleanHtml(extractAuthorFromJsonLd(article.author));

      return { title, subtitle, descriptor, publishedAt, author };
    } catch {
      continue;
    }
  }

  return {};
}

function findNewsArticleNode(input: unknown): Record<string, unknown> | null {
  if (!input) {
    return null;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findNewsArticleNode(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const type = String(obj["@type"] ?? "");

    if (["NewsArticle", "Article", "ReportageNewsArticle"].some((t) => type.includes(t))) {
      return obj;
    }

    if (Array.isArray(obj["@graph"])) {
      const found = findNewsArticleNode(obj["@graph"]);
      if (found) {
        return found;
      }
    }

    for (const value of Object.values(obj)) {
      const found = findNewsArticleNode(value);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function extractAuthorFromJsonLd(authorNode: unknown): string {
  if (typeof authorNode === "string") {
    return authorNode;
  }

  if (Array.isArray(authorNode)) {
    const names = authorNode.map((item) => extractAuthorFromJsonLd(item)).filter(Boolean);
    return names.join(", ");
  }

  if (authorNode && typeof authorNode === "object") {
    const obj = authorNode as Record<string, unknown>;
    return String(obj.name ?? "");
  }

  return "";
}

function extractMetaContent(html: string, attr: "name" | "property", value: string): string {
  const regex = new RegExp(
    `<meta[^>]*${attr}=["']${escapeRegex(value)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const reverse = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${escapeRegex(value)}["'][^>]*>`,
    "i",
  );

  return regex.exec(html)?.[1] ?? reverse.exec(html)?.[1] ?? "";
}

function extractXmlTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${escapeRegex(tag)}[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, "i");
  return regex.exec(xml)?.[1] ?? "";
}

function extractFallbackCardBlocks(html: string): string[] {
  const blocks = [...html.matchAll(/<(div|li|section)[^>]*class=["'][^"']*(noticia|news|story|item|article)[^"']*["'][\s\S]*?<\/(div|li|section)>/gi)]
    .map((m) => m[0]);
  return blocks.slice(0, 800);
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
      !normalized.pathname.includes("/servicios/") &&
      looksLikeArticlePath(normalized.pathname)
    ) {
      return normalized;
    }
  }
  return null;
}


function looksLikeArticlePath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  const blocked = [
    "/servicios/",
    "/contacto",
    "/condiciones-uso",
    "/compromisos-periodisticos",
    "/reglamento",
    "/servicio-utig",
    "/temas/generales/",
    "/areapersonal",
    "/gestion/",
  ];

  if (blocked.some((token) => path.includes(token))) {
    return false;
  }

  return path.endsWith('.html');
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
    .replace(/<!\[CDATA\[|\]\]>/g, "")
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
