"use client";

import { FormEvent, useState } from "react";

type ExportFormat = "csv" | "json" | "markdown" | "pdf";

type TrendSuggestion = {
  term: string;
  link?: string;
  score: number;
  reasons: {
    keywordsMatched: string[];
    relatedArticles: Array<{ title: string; url: string; publishedAt: string }>;
  };
};

type TrendsResponse = {
  geo: string;
  source: string;
  generatedAt: string;
  profileSummary: {
    topKeywords: string[];
    topBigrams: string[];
    topDescriptors: string[];
    articlesCount: number;
    dateRange: { min: string | null; max: string | null };
  };
  trends: {
    match: TrendSuggestion[];
    adjacent: TrendSuggestion[];
    gaps: TrendSuggestion[];
  };
};

const formats: { value: ExportFormat; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "markdown", label: "Markdown" },
  { value: "pdf", label: "PDF" },
];

export default function Home() {
  const [authorUrl, setAuthorUrl] = useState("");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [trendsError, setTrendsError] = useState("");
  const [trendsData, setTrendsData] = useState<TrendsResponse | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setStatus("Recopilando y exportando artículos...");

    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ authorUrl, format }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "No se pudo generar la descarga.");
      }

      const blob = await response.blob();
      const filename = getFilenameFromHeaders(response.headers, format);
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      setStatus("¡Descarga lista!");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ha ocurrido un error inesperado.";
      setStatus(message);
    } finally {
      setLoading(false);
    }
  };

  const handleTrends = async () => {
    setTrendsLoading(true);
    setTrendsError("");

    try {
      const response = await fetch("/api/trends-suggestions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ authorUrl, geo: "ES" }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "No se pudieron generar sugerencias.");
      }

      const data = (await response.json()) as TrendsResponse;
      setTrendsData(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudieron cargar tendencias.";
      setTrendsError(message);
      setTrendsData(null);
    } finally {
      setTrendsLoading(false);
    }
  };

  return (
    <main className="app-shell">
      <section className="card" aria-live="polite">
        <div>
          <p className="eyebrow">Vocento Article Exporter</p>
          <h1>Descarga tus artículos por URL de autor</h1>
          <p className="subtitle">
            Pega la URL de tu perfil de autor en cualquier diario de Vocento y descarga todos tus
            titulares, subtítulos y descriptores en el formato perfecto para análisis.
          </p>
        </div>

        <form className="export-form" onSubmit={handleSubmit}>
          <label htmlFor="author-url">URL de autor</label>
          <input
            id="author-url"
            type="url"
            required
            placeholder="https://www.laverdad.es/autor/tu-nombre-123.html"
            value={authorUrl}
            onChange={(event) => setAuthorUrl(event.target.value)}
          />

          <label htmlFor="format">Formato de exportación</label>
          <select
            id="format"
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
          >
            {formats.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <button type="submit" disabled={loading}>
            {loading ? "Preparando descarga..." : "Descargar artículos"}
          </button>
        </form>

        <p className="status">{status}</p>

        <div className="trends-box">
          <div className="trends-head">
            <h2>Sugerencias de Trends</h2>
            <button type="button" onClick={handleTrends} disabled={trendsLoading || !authorUrl}>
              {trendsLoading ? "Analizando..." : "Generar sugerencias"}
            </button>
          </div>

          {trendsError ? <p className="trends-error">{trendsError}</p> : null}

          {trendsData ? (
            <>
              <p className="trends-meta">
                {trendsData.profileSummary.articlesCount} artículos analizados · GEO {trendsData.geo}
              </p>
              <TrendsList title="Match" items={trendsData.trends.match} />
              <TrendsList title="Adjacent" items={trendsData.trends.adjacent} />
              <TrendsList title="Gaps" items={trendsData.trends.gaps} />
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function TrendsList({ title, items }: { title: string; items: TrendSuggestion[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="trends-list">
      <h3>{title}</h3>
      <ul>
        {items.slice(0, 5).map((item) => (
          <li key={`${title}-${item.term}`}>
            <p>
              <strong>{item.term}</strong> <span>({item.score.toFixed(2)})</span>
            </p>
            {item.reasons.keywordsMatched.length > 0 ? (
              <p className="chips">{item.reasons.keywordsMatched.join(" · ")}</p>
            ) : null}
            {item.link ? (
              <a href={item.link} target="_blank" rel="noreferrer">
                Ver tendencia
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function getFilenameFromHeaders(headers: Headers, format: ExportFormat): string {
  const disposition = headers.get("Content-Disposition");
  const match = disposition?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? `articulos.${format === "markdown" ? "md" : format}`;
}
