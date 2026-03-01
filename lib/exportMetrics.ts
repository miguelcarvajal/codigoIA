import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

type ExportLogStatus = "connection" | "success" | "error";

export type ExportLogEntry = {
  id: string;
  status: ExportLogStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  httpStatus: number;
  format: string;
  authorUrl: string;
  articles: number;
  error: string;
  connection: {
    ip: string;
    forwardedFor: string;
    userAgent: string;
    referer: string;
    host: string;
    country: string;
    city: string;
  };
};

type DailyCounters = {
  visits: number;
  connections: number;
  downloads: number;
  errors: number;
};

type MetricsSnapshot = {
  totals: DailyCounters;
  history: Array<{ date: string } & DailyCounters>;
  recentLogs: ExportLogEntry[];
  generatedAt: string;
  storage: {
    mode: "file" | "neon";
    file?: string;
    endpoint?: string;
  };
};

type ExportMetricsStore = {
  totals: DailyCounters;
  daily: Record<string, DailyCounters>;
  recentLogs: ExportLogEntry[];
  updatedAt: string;
};

type TrackContext = {
  id: string;
  startedAtMs: number;
  startedAtIso: string;
  format: string;
  authorUrl: string;
  connection: ExportLogEntry["connection"];
};

type FinishPayload = {
  httpStatus: number;
  articles?: number;
  error?: string;
};

type NeonQueryResult<T> = {
  rows: T[];
};

const MAX_RECENT_LOGS = 1000;
const MAX_DAILY_HISTORY_DAYS = 365;
const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "export-metrics.json");

const NEON_SQL_ENDPOINT = process.env.NEON_SQL_ENDPOINT?.trim() ?? "";
const NEON_SQL_TOKEN = process.env.NEON_SQL_TOKEN?.trim() ?? "";

let cachedStore: ExportMetricsStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let neonInitPromise: Promise<void> | null = null;

function usingNeon(): boolean {
  return Boolean(NEON_SQL_ENDPOINT);
}

function getTodayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function emptyCounters(): DailyCounters {
  return { visits: 0, connections: 0, downloads: 0, errors: 0 };
}

function createEmptyStore(): ExportMetricsStore {
  return {
    totals: emptyCounters(),
    daily: {},
    recentLogs: [],
    updatedAt: new Date().toISOString(),
  };
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readStoreFromDisk(): Promise<ExportMetricsStore> {
  await ensureDataDir();
  try {
    const content = await fs.readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(content) as Partial<ExportMetricsStore>;
    return {
      totals: {
        ...emptyCounters(),
        ...(parsed.totals ?? {}),
      },
      daily: parsed.daily ?? {},
      recentLogs: Array.isArray(parsed.recentLogs) ? parsed.recentLogs : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return createEmptyStore();
  }
}

async function loadStore(): Promise<ExportMetricsStore> {
  if (cachedStore) {
    return cachedStore;
  }

  cachedStore = await readStoreFromDisk();
  return cachedStore;
}

function trimDailyHistory(store: ExportMetricsStore): void {
  const keys = Object.keys(store.daily).sort();
  if (keys.length <= MAX_DAILY_HISTORY_DAYS) {
    return;
  }

  const removeCount = keys.length - MAX_DAILY_HISTORY_DAYS;
  for (let i = 0; i < removeCount; i += 1) {
    delete store.daily[keys[i]];
  }
}

async function persistStore(store: ExportMetricsStore): Promise<void> {
  store.updatedAt = new Date().toISOString();
  trimDailyHistory(store);
  await ensureDataDir();
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf-8");
}

async function mutateStore(mutator: (store: ExportMetricsStore) => void): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const store = await loadStore();
    mutator(store);
    await persistStore(store);
  });

  await writeQueue;
}

async function getStoreSnapshot(): Promise<ExportMetricsStore> {
  await writeQueue;
  const store = await loadStore();
  return JSON.parse(JSON.stringify(store)) as ExportMetricsStore;
}

async function neonQuery<T>(query: string, params: unknown[] = []): Promise<NeonQueryResult<T>> {
  if (!NEON_SQL_ENDPOINT) {
    throw new Error("NEON_SQL_ENDPOINT no configurado.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (NEON_SQL_TOKEN) {
    headers.Authorization = `Bearer ${NEON_SQL_TOKEN}`;
  }

  const response = await fetch(NEON_SQL_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, params }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Neon query failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as { rows?: T[] };
  return { rows: payload.rows ?? [] };
}

async function ensureNeonSchema(): Promise<void> {
  if (!usingNeon()) {
    return;
  }

  if (!neonInitPromise) {
    neonInitPromise = (async () => {
      await neonQuery(`
        CREATE TABLE IF NOT EXISTS export_metrics_events (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          duration_ms INTEGER,
          http_status INTEGER,
          format TEXT,
          author_url TEXT,
          articles INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          ip TEXT,
          forwarded_for TEXT,
          user_agent TEXT,
          referer TEXT,
          host TEXT,
          country TEXT,
          city TEXT
        );
      `);

      await neonQuery(`
        CREATE INDEX IF NOT EXISTS idx_export_metrics_events_created_at
        ON export_metrics_events (created_at DESC);
      `);

      await neonQuery(`
        CREATE INDEX IF NOT EXISTS idx_export_metrics_events_kind_status
        ON export_metrics_events (kind, status);
      `);
    })();
  }

  await neonInitPromise;
}

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const firstForwarded = forwardedFor.split(",")[0]?.trim();
  return firstForwarded || request.headers.get("x-real-ip") || "unknown";
}

function upsertToday(store: ExportMetricsStore): DailyCounters {
  const key = getTodayKey();
  if (!store.daily[key]) {
    store.daily[key] = emptyCounters();
  }
  return store.daily[key];
}

function pushLog(store: ExportMetricsStore, entry: ExportLogEntry): void {
  store.recentLogs.unshift(entry);
  if (store.recentLogs.length > MAX_RECENT_LOGS) {
    store.recentLogs.length = MAX_RECENT_LOGS;
  }
}

function buildConnectionFromRequest(request: NextRequest): ExportLogEntry["connection"] {
  return {
    ip: getClientIp(request),
    forwardedFor: request.headers.get("x-forwarded-for") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
    referer: request.headers.get("referer") ?? "",
    host: request.headers.get("host") ?? "",
    country: request.headers.get("x-vercel-ip-country") ?? "",
    city: request.headers.get("x-vercel-ip-city") ?? "",
  };
}

export async function trackVisit(): Promise<void> {
  if (usingNeon()) {
    await ensureNeonSchema();
    await neonQuery(
      `
        INSERT INTO export_metrics_events (id, kind, status, created_at)
        VALUES ($1, 'visit', 'visit', NOW());
      `,
      [crypto.randomUUID()],
    );
    return;
  }

  await mutateStore((store) => {
    store.totals.visits += 1;
    const day = upsertToday(store);
    day.visits += 1;
  });
}

export async function startExportTracking(
  request: NextRequest,
  input: { format?: string; authorUrl?: string },
): Promise<TrackContext> {
  const connection = buildConnectionFromRequest(request);
  const id = crypto.randomUUID();
  const startedAtIso = new Date().toISOString();

  if (usingNeon()) {
    await ensureNeonSchema();
    await neonQuery(
      `
        INSERT INTO export_metrics_events (
          id, kind, status, created_at, started_at,
          format, author_url, ip, forwarded_for, user_agent, referer, host, country, city
        ) VALUES (
          $1, 'export', 'connection', NOW(), NOW(),
          $2, $3, $4, $5, $6, $7, $8, $9, $10
        );
      `,
      [
        id,
        input.format ?? "unknown",
        input.authorUrl ?? "",
        connection.ip,
        connection.forwardedFor,
        connection.userAgent,
        connection.referer,
        connection.host,
        connection.country,
        connection.city,
      ],
    );
  } else {
    await mutateStore((store) => {
      store.totals.connections += 1;
      const day = upsertToday(store);
      day.connections += 1;

      pushLog(store, {
        id,
        status: "connection",
        startedAt: startedAtIso,
        finishedAt: "",
        durationMs: 0,
        httpStatus: 0,
        format: input.format ?? "unknown",
        authorUrl: input.authorUrl ?? "",
        articles: 0,
        error: "",
        connection,
      });
    });
  }

  return {
    id,
    startedAtMs: Date.now(),
    startedAtIso,
    format: input.format ?? "unknown",
    authorUrl: input.authorUrl ?? "",
    connection,
  };
}

export async function trackExportSuccess(context: TrackContext, payload: FinishPayload): Promise<void> {
  if (usingNeon()) {
    await ensureNeonSchema();
    await neonQuery(
      `
        UPDATE export_metrics_events
        SET
          status = 'success',
          finished_at = NOW(),
          duration_ms = $2,
          http_status = $3,
          articles = $4,
          error = ''
        WHERE id = $1;
      `,
      [context.id, Date.now() - context.startedAtMs, payload.httpStatus, payload.articles ?? 0],
    );
    return;
  }

  await mutateStore((store) => {
    store.totals.downloads += 1;
    const day = upsertToday(store);
    day.downloads += 1;

    const existing = store.recentLogs.find((entry) => entry.id === context.id);
    if (existing) {
      existing.status = "success";
      existing.finishedAt = new Date().toISOString();
      existing.durationMs = Date.now() - context.startedAtMs;
      existing.httpStatus = payload.httpStatus;
      existing.articles = payload.articles ?? 0;
      existing.error = "";
    }
  });
}

export async function trackExportError(context: TrackContext, payload: FinishPayload): Promise<void> {
  if (usingNeon()) {
    await ensureNeonSchema();
    await neonQuery(
      `
        UPDATE export_metrics_events
        SET
          status = 'error',
          finished_at = NOW(),
          duration_ms = $2,
          http_status = $3,
          articles = $4,
          error = $5
        WHERE id = $1;
      `,
      [
        context.id,
        Date.now() - context.startedAtMs,
        payload.httpStatus,
        payload.articles ?? 0,
        payload.error ?? "Error desconocido",
      ],
    );
    return;
  }

  await mutateStore((store) => {
    store.totals.errors += 1;
    const day = upsertToday(store);
    day.errors += 1;

    const existing = store.recentLogs.find((entry) => entry.id === context.id);
    if (existing) {
      existing.status = "error";
      existing.finishedAt = new Date().toISOString();
      existing.durationMs = Date.now() - context.startedAtMs;
      existing.httpStatus = payload.httpStatus;
      existing.articles = payload.articles ?? 0;
      existing.error = payload.error ?? "Error desconocido";
    }
  });
}

async function getNeonSnapshot(): Promise<MetricsSnapshot> {
  await ensureNeonSchema();

  const totals = await neonQuery<DailyCounters>(`
    SELECT
      COUNT(*) FILTER (WHERE kind = 'visit')::INT AS visits,
      COUNT(*) FILTER (WHERE kind = 'export')::INT AS connections,
      COUNT(*) FILTER (WHERE kind = 'export' AND status = 'success')::INT AS downloads,
      COUNT(*) FILTER (WHERE kind = 'export' AND status = 'error')::INT AS errors
    FROM export_metrics_events;
  `);

  const history = await neonQuery<Array<{ date: string } & DailyCounters>[number]>(`
    SELECT
      DATE_TRUNC('day', COALESCE(started_at, created_at))::DATE::TEXT AS date,
      COUNT(*) FILTER (WHERE kind = 'visit')::INT AS visits,
      COUNT(*) FILTER (WHERE kind = 'export')::INT AS connections,
      COUNT(*) FILTER (WHERE kind = 'export' AND status = 'success')::INT AS downloads,
      COUNT(*) FILTER (WHERE kind = 'export' AND status = 'error')::INT AS errors
    FROM export_metrics_events
    WHERE COALESCE(started_at, created_at) >= NOW() - INTERVAL '365 days'
    GROUP BY 1
    ORDER BY 1 ASC;
  `);

  const logs = await neonQuery<{
    id: string;
    status: ExportLogStatus;
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
    http_status: number | null;
    format: string | null;
    author_url: string | null;
    articles: number | null;
    error: string | null;
    ip: string | null;
    forwarded_for: string | null;
    user_agent: string | null;
    referer: string | null;
    host: string | null;
    country: string | null;
    city: string | null;
  }>(`
    SELECT
      id, status, started_at, finished_at, duration_ms, http_status, format, author_url, articles, error,
      ip, forwarded_for, user_agent, referer, host, country, city
    FROM export_metrics_events
    WHERE kind = 'export'
    ORDER BY COALESCE(finished_at, started_at, created_at) DESC
    LIMIT 300;
  `);

  return {
    totals: totals.rows[0] ?? emptyCounters(),
    history: history.rows,
    recentLogs: logs.rows.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.started_at ?? "",
      finishedAt: row.finished_at ?? "",
      durationMs: row.duration_ms ?? 0,
      httpStatus: row.http_status ?? 0,
      format: row.format ?? "",
      authorUrl: row.author_url ?? "",
      articles: row.articles ?? 0,
      error: row.error ?? "",
      connection: {
        ip: row.ip ?? "",
        forwardedFor: row.forwarded_for ?? "",
        userAgent: row.user_agent ?? "",
        referer: row.referer ?? "",
        host: row.host ?? "",
        country: row.country ?? "",
        city: row.city ?? "",
      },
    })),
    generatedAt: new Date().toISOString(),
    storage: {
      mode: "neon",
      endpoint: NEON_SQL_ENDPOINT,
    },
  };
}

async function getFileSnapshot(): Promise<MetricsSnapshot> {
  const store = await getStoreSnapshot();
  const history = Object.entries(store.daily)
    .map(([date, counters]) => ({ date, ...counters }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totals: store.totals,
    history,
    recentLogs: store.recentLogs,
    generatedAt: new Date().toISOString(),
    storage: {
      mode: "file",
      file: DATA_FILE,
    },
  };
}

export async function getExportMetricsSnapshot(): Promise<MetricsSnapshot> {
  if (usingNeon()) {
    return getNeonSnapshot();
  }

  return getFileSnapshot();
}
