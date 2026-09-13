/**
 * DeepSeek rates — shared data layer (used by `deepseek-rates` and `model-prices`).
 *
 * DeepSeek exposes NO pricing API (api.deepseek.com/* is auth-gated and has no
 * pricing route), so rates and the peak schedule are parsed from the official
 * pricing page. The live model list is available through the real API
 * (`GET /models`) and is used only to notice new/renamed models.
 *
 * Caching: a successful parse is stored in-memory and on disk
 * (~/.pi/deepseek-rates-cache.json); consumers call `ensureRates()` which is a
 * no-op unless the cached prices are older than PRICES_TTL_MS (24 h).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export const PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
export const MODELS_URL = "https://api.deepseek.com/models";
export const PRICES_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
export const FETCH_TIMEOUT_MS = 10_000;
export const CACHE_PATH = path.join(homedir(), ".pi", "deepseek-rates-cache.json");

// ── Types ───────────────────────────────────────────────────────────────

export type Period = "off" | "peak";
export type Metric = "cacheHit" | "cacheMiss" | "output";

export interface MetricRates {
  off: number;
  peak: number;
}

export interface ModelRates {
  cacheHit: MetricRates;
  cacheMiss: MetricRates;
  output: MetricRates;
}

export interface PeakWindow {
  start: number; // inclusive UTC hour
  end: number; // exclusive UTC hour
}

export interface RatesData {
  pricesFetchedAt: number;
  source: string;
  models: Record<string, ModelRates>;
  peakWindows: PeakWindow[];
  weekdaysOnly: boolean;
}

export interface CostLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PricedModel {
  provider: string;
  id: string;
  cost?: CostLike | null;
}

// Fallback schedule, used until the page has been parsed once.
export const DEFAULT_PEAK_WINDOWS: PeakWindow[] = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
];

// Retired names that the docs say are billed at another model's price.
export const LEGACY_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

// ── Parsing ─────────────────────────────────────────────────────────────

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function emptyRates(): ModelRates {
  return {
    cacheHit: { off: 0, peak: 0 },
    cacheMiss: { off: 0, peak: 0 },
    output: { off: 0, peak: 0 },
  };
}

/** True when an entry actually carries prices (all-zero entries mean "unknown"). */
export function hasAnyRate(r: ModelRates | undefined): r is ModelRates {
  if (!r) return false;
  return (
    r.cacheMiss.off > 0 ||
    r.cacheMiss.peak > 0 ||
    r.output.off > 0 ||
    r.output.peak > 0 ||
    r.cacheHit.off > 0 ||
    r.cacheHit.peak > 0
  );
}

/** Parse the official pricing page: model ids, per-metric rates and peak windows. */
export function parsePricing(html: string): Omit<RatesData, "pricesFetchedAt" | "source"> {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);

  // Model ids come from the header row (the footnotes also mention retired
  // names, so scanning the whole page would pick those up).
  const headerRowHtml = rows.find((r) => /<t[dh]\b[^>]*>\s*MODEL\s*<\/t[dh]>/i.test(r));
  const ids = headerRowHtml
    ? [...headerRowHtml.matchAll(/<t[dh]\b[^>]*>\s*(deepseek-[a-z0-9_.-]+)/gi)].map((m) => m[1])
    : [];

  const models: Record<string, ModelRates> = {};
  const forId = (id: string): ModelRates => (models[id] ??= emptyRates());
  ids.forEach(forId);

  let metric: Metric | null = null;
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripHtml(c[1]));
    const joined = cells.join(" | ");

    if (/CACHE\s*HIT/i.test(joined)) metric = "cacheHit";
    else if (/CACHE\s*MISS/i.test(joined)) metric = "cacheMiss";
    else if (/OUTPUT\s*TOKENS/i.test(joined)) metric = "output";
    else if (/Concurrency/i.test(joined)) metric = null;

    const period: Period | null = cells.some((c) => /^OFF-PEAK$/i.test(c))
      ? "off"
      : cells.some((c) => /^PEAK$/i.test(c))
        ? "peak"
        : null;
    if (!metric || !period) continue;

    const prices = cells
      .filter((c) => /^\$\s*\d/.test(c))
      .map((c) => Number(c.replace(/[^0-9.]/g, "")))
      .filter((n) => Number.isFinite(n));
    prices.forEach((price, i) => {
      const id = ids[i] ?? Object.keys(models)[i];
      if (id) forId(id)[metric as Metric][period] = price;
    });
  }

  // Peak windows from footnote: "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday"
  const footnote = html.match(/Peak hours are([\s\S]{0,300}?)UTC/i);
  const scope = footnote ? footnote[1] : "";
  const peakWindows: PeakWindow[] = [];
  for (const m of scope.matchAll(/(\d{1,2}):00\s*[-–—]\s*(\d{1,2}):00/g)) {
    peakWindows.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  const weekdaysOnly =
    /Monday\s+through\s+Friday/i.test(html) || /Mon(?:day)?\s*[-–—]\s*Fri(?:day)?/i.test(html);

  return {
    models,
    peakWindows: peakWindows.length ? peakWindows : DEFAULT_PEAK_WINDOWS,
    weekdaysOnly,
  };
}

/** Current billing period. Honours the weekdays-only rule (weekend is off-peak). */
export function peakPeriod(now: Date, windows: PeakWindow[], weekdaysOnly: boolean): Period {
  if (weekdaysOnly) {
    const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (day === 0 || day === 6) return "off";
  }
  const hour = now.getUTCHours();
  return windows.some((w) => hour >= w.start && hour < w.end) ? "peak" : "off";
}

/** Period for the given data (or the built-in defaults) right now. */
export function currentPeriod(data: RatesData | null, now: Date = new Date()): Period {
  return peakPeriod(now, data?.peakWindows ?? DEFAULT_PEAK_WINDOWS, data?.weekdaysOnly ?? true);
}

// ── Cache ───────────────────────────────────────────────────────────────

export function readCache(): RatesData | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as RatesData & {
      fetchedAt?: number; // older field name, migrated on read
    };
    if (!raw || typeof raw !== "object" || !raw.models) return null;
    if (!Array.isArray(raw.peakWindows) || !raw.peakWindows.length) {
      raw.peakWindows = DEFAULT_PEAK_WINDOWS;
    }
    raw.pricesFetchedAt = raw.pricesFetchedAt ?? raw.fetchedAt ?? 0;
    return raw;
  } catch {
    return null;
  }
}

export function writeCache(data: RatesData): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, CACHE_PATH);
  } catch {
    /* cache is best-effort */
  }
}

// ── Fetch ───────────────────────────────────────────────────────────────

export async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "pi-deepseek-rates/3.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function readDeepSeekKey(): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const auth = JSON.parse(
      fs.readFileSync(path.join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
    ) as Record<string, { key?: string; apiKey?: string }>;
    return auth?.deepseek?.key ?? auth?.deepseek?.apiKey;
  } catch {
    return undefined;
  }
}

/** Real API call to notice new/renamed models (carries no pricing). */
export async function fetchModelIds(): Promise<string[]> {
  try {
    const key = readDeepSeekKey();
    if (!key) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(MODELS_URL, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${key}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return [];
  }
}

// ── Store (in-memory + disk cache with TTL) ─────────────────────────────

let store: RatesData | null = null;
let storeLoaded = false;
let inFlight: Promise<RatesData | null> | null = null;

/** Cached rates, loaded from disk on first access. */
export function getRates(): RatesData | null {
  if (!storeLoaded) {
    store = readCache();
    storeLoaded = true;
  }
  return store;
}

/** Overwrite the in-memory store (used by tests). */
export function setRates(data: RatesData | null): void {
  store = data;
  storeLoaded = true;
}

/**
 * Fetch rates when the cached copy is older than `maxAgeMs` (default 24 h).
 * Never throws; returns the best data available (possibly the previous cache).
 */
export async function ensureRates(
  opts: { force?: boolean; maxAgeMs?: number } = {},
): Promise<RatesData | null> {
  const maxAge = opts.maxAgeMs ?? PRICES_TTL_MS;
  const cached = getRates();
  if (!opts.force && cached && Date.now() - cached.pricesFetchedAt < maxAge) return cached;
  if (inFlight) return inFlight;

  const run = (async (): Promise<RatesData | null> => {
    try {
      const html = await fetchText(PRICING_URL);
      const parsed = parsePricing(html);
      if (Object.keys(parsed.models).length) {
        const next: RatesData = { ...parsed, pricesFetchedAt: Date.now(), source: PRICING_URL };
        // best-effort: notice new/renamed models from the real API
        for (const id of await fetchModelIds()) {
          if (!next.models[id]) next.models[id] = emptyRates();
        }
        setRates(next);
        writeCache(next);
      }
    } catch {
      /* keep whatever we had (cache) */
    }
    return getRates();
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

// ── Model helpers ───────────────────────────────────────────────────────

/** Resolve the rates for a model id, following the documented legacy aliases. */
export function ratesFor(data: RatesData | null, modelId: string): ModelRates | null {
  if (!data) return null;
  const direct = data.models[modelId];
  if (hasAnyRate(direct)) return direct;
  const alias = LEGACY_ALIASES[modelId];
  if (alias && hasAnyRate(data.models[alias])) return data.models[alias];
  // prefix match, e.g. a dated id such as deepseek-v4-pro-0813
  const key = Object.keys(data.models).find(
    (id) => modelId.startsWith(id) && hasAnyRate(data.models[id]),
  );
  return key ? data.models[key] : null;
}

/** Rates for one model, flattened to pi's `cost` shape for the given period. */
export function deepSeekCost(r: ModelRates, period: Period): CostLike {
  return {
    input: r.cacheMiss[period],
    output: r.output[period],
    cacheRead: r.cacheHit[period],
    cacheWrite: r.cacheMiss[period],
  };
}

/** True when the catalogue contains at least one DeepSeek model. */
export function hasDeepSeek(models: readonly PricedModel[]): boolean {
  return models.some((m) => m.provider === "deepseek" || /^deepseek/i.test(m.id));
}

/**
 * Return a copy of `models` where DeepSeek entries carry the fetched rates
 * (registry prices for those models are known to be stale). Non-DeepSeek
 * models, and DeepSeek models without fetched rates, are passed through.
 */
export function applyDeepSeekRates<T extends PricedModel>(
  models: readonly T[],
  data: RatesData | null,
  period: Period,
): T[] {
  if (!data) return models as T[];
  return models.map((m) => {
    if (m.provider !== "deepseek") return m;
    const r = ratesFor(data, m.id);
    if (!r) return m;
    return { ...m, cost: deepSeekCost(r, period) };
  });
}
