import { NextRequest, NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import {
  buildAuthorProfile,
  collectAuthorPreviews,
  enrichArticles,
  parseAndValidateAuthorUrl,
  type ArticlePreview,
} from "@/lib/authorProfile";

type TrendItem = { term: string; link?: string; pubDate?: string };

type TrendSuggestion = {
  term: string;
  link?: string;
  score: number;
  reasons: {
    keywordsMatched: string[];
    relatedArticles: Array<{ title: string; url: string; publishedAt: string }>;
  };
};

const DEFAULT_GEO = "ES";
const TRENDS_TIMEOUT_MS = 9000;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { authorUrl?: string; geo?: string };
    const authorUrl = body.authorUrl?.trim();

    if (!authorUrl) {
      return NextResponse.json({ error: "Debes indicar authorUrl." }, { status: 400 });
    }

    const geo = sanitizeGeo(body.geo);
    const context = parseAndValidateAuthorUrl(authorUrl);
    const previews = await collectAuthorPreviews(context);
    const articles = await enrichArticles(previews, context.authorName, context);

    if (articles.length === 0) {
      return NextResponse.json({ error: "No se han encontrado artículos para ese autor." }, { status: 404 });
    }

    const trends = await fetchGoogleTrendsRss(geo);
    if (trends.length === 0) {
      return NextResponse.json({ error: "No se pudieron cargar tendencias RSS." }, { status: 502 });
    }

    const profile = buildAuthorProfile(articles);
    const classified = classifyTrends(trends, articles, profile);

    return NextResponse.json({
      geo,
      source: "trending-rss",
      generatedAt: new Date().toISOString(),
      profileSummary: profile,
      trends: classified,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    const status = message.includes("RSS") ? 502 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

function sanitizeGeo(input?: string): string {
  const value = (input ?? DEFAULT_GEO).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) {
    return DEFAULT_GEO;
  }
  return value;
}

async function fetchGoogleTrendsRss(geo: string): Promise<TrendItem[]> {
  const url = `https://trends.google.com/trending/rss?geo=${geo}&hours=24`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRENDS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VocentoTrendsSuggestions/1.0)",
        Accept: "application/rss+xml,application/xml,text/xml",
      },
      cache: "force-cache",
      next: { revalidate: 600 },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`RSS Google Trends no disponible (${response.status})`);
    }

    const xml = await response.text();
    return parseTrendsRss(xml);
  } catch {
    throw new Error("Error al obtener RSS de Google Trends.");
  } finally {
    clearTimeout(timeout);
  }
}

function parseTrendsRss(xml: string): TrendItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: Array<{ title?: string; link?: string; pubDate?: string }> | { title?: string; link?: string; pubDate?: string } } };
  };

  const itemsRaw = parsed.rss?.channel?.item;
  const items = Array.isArray(itemsRaw) ? itemsRaw : itemsRaw ? [itemsRaw] : [];

  return items
    .map((item) => ({
      term: decodeXml(String(item.title ?? "")),
      link: item.link?.trim(),
      pubDate: item.pubDate?.trim(),
    }))
    .filter((item) => item.term.length > 0);
}

function decodeXml(input: string): string {
  return input
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function classifyTrends(trends: TrendItem[], articles: ArticlePreview[], profile: ReturnType<typeof buildAuthorProfile>) {
  const profileKeywords = new Set(profile.topKeywords);
  const profileBigrams = new Set(profile.topBigrams);
  const descriptorTokens = new Set(profile.topDescriptors.flatMap(tokenize));

  const scored = trends.map((trend) => {
    const terms = tokenize(trend.term);
    const trendBigrams = makeBigrams(terms);

    const keywordsMatched = terms.filter((token) => profileKeywords.has(token));
    const bigramsMatched = trendBigrams.filter((pair) => profileBigrams.has(pair));

    const overlapScore = keywordsMatched.length * 0.14 + bigramsMatched.length * 0.22;
    const descriptorBonus = terms.some((token) => descriptorTokens.has(token)) ? 0.2 : 0;
    const score = Number((overlapScore + descriptorBonus).toFixed(3));

    const relatedArticles = selectRelatedArticles(trend.term, articles, 4);

    const suggestion: TrendSuggestion = {
      term: trend.term,
      link: trend.link,
      score,
      reasons: {
        keywordsMatched: [...new Set([...keywordsMatched, ...bigramsMatched])].slice(0, 8),
        relatedArticles,
      },
    };

    return suggestion;
  });

  const match = scored.filter((item) => item.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, 10);
  const adjacent = scored
    .filter((item) => item.score > 0 && item.score < 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  const gaps = scored.filter((item) => item.score === 0).slice(0, 10);

  return { match, adjacent, gaps };
}

function selectRelatedArticles(term: string, articles: ArticlePreview[], limit: number) {
  const trendTokens = new Set(tokenize(term));

  return articles
    .map((article) => {
      const textTokens = tokenize(`${article.title} ${article.subtitle} ${article.descriptor}`);
      const overlap = textTokens.filter((token) => trendTokens.has(token)).length;
      return { article, overlap };
    })
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, Math.max(2, Math.min(4, limit)))
    .map(({ article }) => ({ title: article.title, url: article.url, publishedAt: article.publishedAt }));
}

const STOPWORDS_ES = new Set([
  "de", "la", "que", "el", "en", "y", "a", "los", "del", "se", "las", "por", "un", "para", "con",
  "no", "una", "su", "al", "lo", "como", "mas", "pero", "sus", "le", "ya", "o", "fue", "ha", "si",
  "porque", "esta", "son", "entre", "cuando", "muy", "sin", "sobre", "tambien", "me", "hasta", "hay",
  "donde", "quien", "desde", "todo", "nos", "durante", "todos", "uno", "les", "ni", "contra", "otros",
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !STOPWORDS_ES.has(part));
}

function makeBigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}
