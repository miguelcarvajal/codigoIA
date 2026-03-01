"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type MetricsResponse = {
  totals: {
    visits: number;
    connections: number;
    downloads: number;
    errors: number;
  };
  history: Array<{
    date: string;
    visits: number;
    connections: number;
    downloads: number;
    errors: number;
  }>;
  recentLogs: Array<{
    id: string;
    status: "connection" | "success" | "error";
    finishedAt: string;
    durationMs: number;
    httpStatus: number;
    format: string;
    authorUrl: string;
    articles: number;
    error: string;
    connection: {
      ip: string;
      userAgent: string;
      referer: string;
      host: string;
      country: string;
      city: string;
    };
  }>;
  generatedAt: string;
  storage?: {
    mode: string;
    file: string;
  };
};

const STORAGE_KEY = "vocento_admin_dashboard_key";

export default function AdminHiddenPage() {
  const [adminKey, setAdminKey] = useState("");
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setAdminKey(saved);
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    if (!adminKey.trim()) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/admin/metrics", {
        headers: {
          "x-admin-key": adminKey.trim(),
        },
      });

      const data = (await response.json()) as MetricsResponse & { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo cargar el panel.");
      }

      setMetrics(data);
      window.localStorage.setItem(STORAGE_KEY, adminKey.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error inesperado";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [adminKey]);

  useEffect(() => {
    if (!adminKey.trim()) {
      return;
    }

    void fetchMetrics();
    const timer = window.setInterval(() => {
      void fetchMetrics();
    }, 15000);

    return () => window.clearInterval(timer);
  }, [adminKey, fetchMetrics]);

  const lastUpdated = useMemo(() => {
    if (!metrics?.generatedAt) {
      return "";
    }
    return new Date(metrics.generatedAt).toLocaleString();
  }, [metrics?.generatedAt]);

  const last30Days = useMemo(() => {
    return (metrics?.history ?? []).slice(-30).reverse();
  }, [metrics?.history]);

  return (
    <main className="admin-shell">
      <section className="admin-topbar">
        <div>
          <h1>Panel Admin Oculto</h1>
          <p>Monitoreo de visitas, conexiones y descargas.</p>
        </div>

        <div className="admin-auth">
          <input
            type="password"
            placeholder="ADMIN_DASHBOARD_KEY"
            value={adminKey}
            onChange={(event) => setAdminKey(event.target.value)}
          />
          <button type="button" onClick={() => void fetchMetrics()} disabled={loading || !adminKey.trim()}>
            {loading ? "Cargando..." : "Entrar / refrescar"}
          </button>
        </div>
      </section>

      {error ? <p className="admin-error">{error}</p> : null}
      {!metrics && !error ? (
        <section className="admin-panel">
          <h2>Sin datos cargados</h2>
          <p>Introduce la clave de admin y pulsa &quot;Entrar / refrescar&quot; para ver métricas.</p>
        </section>
      ) : null}

      {metrics ? (
        <>
          <section className="admin-meta">
            <span>
              <strong>Actualizado:</strong> {lastUpdated}
            </span>
            {metrics.storage ? (
              <span>
                <strong>Persistencia:</strong> {metrics.storage.mode} ({metrics.storage.file})
              </span>
            ) : null}
          </section>

          <section className="admin-stats">
            <StatBox label="Conexiones" value={metrics.totals.connections} />
            <StatBox label="Visitas" value={metrics.totals.visits} />
            <StatBox label="Descargas" value={metrics.totals.downloads} />
            <StatBox label="Errores" value={metrics.totals.errors} />
          </section>

          <section className="admin-panel">
            <h2>Historico diario (ultimos 30 dias)</h2>
            <div className="table-wrap">
              <table className="admin-table compact">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Visitas</th>
                    <th>Conexiones</th>
                    <th>Descargas</th>
                    <th>Errores</th>
                  </tr>
                </thead>
                <tbody>
                  {last30Days.length > 0 ? (
                    last30Days.map((row) => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td>{row.visits}</td>
                        <td>{row.connections}</td>
                        <td>{row.downloads}</td>
                        <td>{row.errors}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5}>Sin históricos todavía.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="admin-panel">
            <h2>Detalle de conexiones/descargas</h2>
            <div className="table-wrap desktop-only">
              <table className="admin-table logs-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Estado</th>
                    <th>HTTP</th>
                    <th>Formato</th>
                    <th>Articulos</th>
                    <th>Duracion</th>
                    <th>IP</th>
                    <th>Pais/Ciudad</th>
                    <th>Host</th>
                    <th>Referer</th>
                    <th>User-Agent</th>
                    <th>URL autor</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.recentLogs.length > 0 ? (
                    metrics.recentLogs.map((row) => (
                      <tr key={row.id}>
                        <td>{new Date(row.finishedAt).toLocaleString()}</td>
                        <td>{row.status}</td>
                        <td>{row.httpStatus}</td>
                        <td>{row.format}</td>
                        <td>{row.articles}</td>
                        <td>{row.durationMs} ms</td>
                        <td>{row.connection.ip || "-"}</td>
                        <td>{[row.connection.country, row.connection.city].filter(Boolean).join(" / ") || "-"}</td>
                        <td>{row.connection.host || "-"}</td>
                        <td>{row.connection.referer || "-"}</td>
                        <td title={row.connection.userAgent}>{row.connection.userAgent || "-"}</td>
                        <td title={row.authorUrl}>{row.authorUrl || "-"}</td>
                        <td title={row.error}>{row.error || "-"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={13}>Sin logs todavía.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mobile-cards">
              {metrics.recentLogs.length > 0 ? (
                metrics.recentLogs.map((row) => (
                  <article className="log-card" key={`m-${row.id}`}>
                    <p><strong>Fecha:</strong> {new Date(row.finishedAt).toLocaleString()}</p>
                    <p><strong>Estado:</strong> {row.status} ({row.httpStatus})</p>
                    <p><strong>Formato:</strong> {row.format}</p>
                    <p><strong>Articulos:</strong> {row.articles}</p>
                    <p><strong>Duracion:</strong> {row.durationMs} ms</p>
                    <p><strong>IP:</strong> {row.connection.ip || "-"}</p>
                    <p><strong>Pais/Ciudad:</strong> {[row.connection.country, row.connection.city].filter(Boolean).join(" / ") || "-"}</p>
                    <p><strong>Host:</strong> {row.connection.host || "-"}</p>
                    <p><strong>Referer:</strong> {row.connection.referer || "-"}</p>
                    <p><strong>User-Agent:</strong> {row.connection.userAgent || "-"}</p>
                    <p><strong>URL autor:</strong> {row.authorUrl || "-"}</p>
                    <p><strong>Error:</strong> {row.error || "-"}</p>
                  </article>
                ))
              ) : (
                <article className="log-card">
                  <p>Sin logs todavía.</p>
                </article>
              )}
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-box">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
