/**
 * Web Search Extension v3.1 — Multi-Provider
 *
 * Supports: SearxNG (self-hosted), Tavily (AI-optimized API), Brave Search (API),
 * DuckDuckGo (HTML scraping), Raw (DDG Lite scraping, absolute fallback).
 * Configurable via ~/.pi/web-search.json (unified config shared with pi-web-access).
 * Migrates automatically from the old ~/.pi/agent/web-search/config.json on first load.
 * Fallback chain: if primary provider fails, next is tried automatically.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Unified result type (all providers normalize to this) ──────────────

interface SearxResult {
  url: string;
  title: string;
  content: string;
  engine: string;
  score: number;
  category: string;
  engines: string[];
  positions: number[];
}

interface SearxAnswer {
  answer: string;
  engine: string;
  template: string;
  url?: string | null;
}

interface SearxInfobox {
  infobox: string;
  title?: string;
  content: string;
  url?: string;
  engine: string;
  engines: string[];
  img_src?: string;
}

interface SearxResponse {
  query: string;
  number_of_results: number;
  results: SearxResult[];
  answers: SearxAnswer[];
  corrections: string[];
  infoboxes: SearxInfobox[];
  suggestions: string[];
  unresponsive_engines: Array<[string, string]>;
}

function emptyResponse(query: string): SearxResponse {
  return {
    query,
    number_of_results: 0,
    results: [],
    answers: [],
    corrections: [],
    infoboxes: [],
    suggestions: [],
    unresponsive_engines: [],
  };
}

// ── Types ───────────────────────────────────────────────────────────────

interface SearchParams {
  query: string;
  limit: number;
  categories: string;
  engines?: string;
  language: string;
  timeRange?: string;
  safesearch?: number;
  page: number;
}

interface SearchProvider {
  readonly name: string;
  search(params: SearchParams, signal: AbortSignal): Promise<SearxResponse>;
}

// ── Config ───────────────────────────────────────────────────────────────

interface ProviderConfig {
  // SearxNG
  baseUrl?: string;
  // Tavily, Brave
  apiKey?: string;
  // DuckDuckGo, Raw
  enabled?: boolean;
}

interface WebSearchConfig {
  // Unified fields (shared with pi-web-access)
  searchProvider?: string;
  provider?: string;                      // legacy alias for searchProvider
  searxngBaseUrl?: string;                // unified SearxNG URL (pi-web-access compat)
  // pi-toolkit specific
  fallbackChain: string[];
  providers: Record<string, ProviderConfig>;
}

// Unified config path (shared with pi-web-access)
const CONFIG_DIR = path.join(os.homedir(), ".pi");
const CONFIG_PATH = path.join(CONFIG_DIR, "web-search.json");
// Legacy config path (auto-migrated on first load)
const LEGACY_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "web-search");
const LEGACY_CONFIG_PATH = path.join(LEGACY_CONFIG_DIR, "config.json");

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function resolveEnvVars(value: string): string {
  // $VAR or ${VAR} → process.env.VAR
  return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, name: string) => {
    return process.env[name] ?? "";
  });
}

/** Resolve the effective provider name (searchProvider or legacy provider field). */
function resolveProviderName(cfg: WebSearchConfig): string {
  return cfg.searchProvider ?? cfg.provider ?? "searxng";
}

/**
 * Load config from the unified path (~/.pi/web-search.json).
 * If not found, migrates from the legacy path (~/.pi/agent/web-search/config.json).
 */
function loadConfig(): WebSearchConfig | null {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const cfg = JSON.parse(raw) as WebSearchConfig;
      // Ensure fallbackChain has a default
      if (!cfg.fallbackChain || cfg.fallbackChain.length === 0) {
        cfg.fallbackChain = ["searxng", "duckduckgo", "raw"];
      }
      // Resolve env vars in apiKey fields
      if (cfg.providers) {
        for (const [name, pcfg] of Object.entries(cfg.providers)) {
          if (pcfg.apiKey) {
            cfg.providers[name].apiKey = resolveEnvVars(pcfg.apiKey);
          }
        }
      }
      return cfg;
    }

    // ── Migration from legacy path ─────────────────────────
    if (fs.existsSync(LEGACY_CONFIG_PATH)) {
      try {
        const raw = fs.readFileSync(LEGACY_CONFIG_PATH, "utf-8");
        const legacy = JSON.parse(raw) as {
          provider?: string;
          fallbackChain?: string[];
          providers?: Record<string, ProviderConfig>;
        };
        // Convert to unified format
        const cfg: WebSearchConfig = {
          searchProvider: legacy.provider,
          fallbackChain: legacy.fallbackChain ?? ["searxng", "duckduckgo", "raw"],
          providers: {},
        };
        // Extract SearxNG baseUrl from legacy nested format
        if (legacy.providers?.searxng?.baseUrl) {
          cfg.searxngBaseUrl = legacy.providers.searxng.baseUrl;
        }
        // Copy non-searxng providers (searxng config is now at root level)
        if (legacy.providers) {
          for (const [name, pcfg] of Object.entries(legacy.providers)) {
            if (name !== "searxng") {
              cfg.providers[name] = pcfg;
            }
            if (pcfg.apiKey) {
              cfg.providers[name] = { ...pcfg, apiKey: resolveEnvVars(pcfg.apiKey) };
            }
          }
        }
        // Write migrated config
        saveConfig(cfg);
        console.error(`[pi-toolkit web-search] Migrated config from ${LEGACY_CONFIG_PATH} to ${CONFIG_PATH}`);
        return cfg;
      } catch (err) {
        console.error(`[pi-toolkit web-search] Failed to migrate legacy config: ${err instanceof Error ? err.message : err}`);
      }
    }

    return null;
  } catch {
    return null;
  }
}

function saveConfig(cfg: WebSearchConfig): void {
  ensureConfigDir();
  // Write to unified path
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// ── Helpers ─────────────────────────────────────────────────────────────

function stripHtml(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&([a-z]+);/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeDDGRedirect(encoded: string): string {
  // DDG encodes URLs as //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
  try {
    const urlMatch = encoded.match(/uddg=([^&]+)/i);
    if (urlMatch) {
      return decodeURIComponent(urlMatch[1]);
    }
  } catch { /* ignore */ }
  // If it starts with //, prepend https:
  if (encoded.startsWith("//")) return "https:" + encoded;
  return encoded;
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; PiAgent/3.0; +https://github.com/earendil-works/pi)";

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_LIMIT = 3;
const RETRY_BASE_DELAY_MS = 800;

async function fetchWithRetry(
  url: string,
  options: RequestInit & { _timeoutMs?: number },
  signal: AbortSignal,
  retries = RETRY_LIMIT
): Promise<Response> {
  const timeoutMs = options._timeoutMs ?? REQUEST_TIMEOUT_MS;
  delete options._timeoutMs;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const linked = AbortSignal.any([signal, controller.signal]);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(url, { ...options, signal: linked });
      clearTimeout(timeoutId);

      if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return resp;
    } catch (err: unknown) {
      lastErr = err;
      if (attempt < retries) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Provider 1: SearxNG ─────────────────────────────────────────────────

class SearxNGProvider implements SearchProvider {
  readonly name = "searxng";
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async search(params: SearchParams, signal: AbortSignal): Promise<SearxResponse> {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", params.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", params.categories);
    url.searchParams.set("pageno", String(params.page));
    if (params.language !== "all") url.searchParams.set("language", params.language);
    if (params.timeRange) url.searchParams.set("time_range", params.timeRange);
    if (params.safesearch !== undefined) url.searchParams.set("safesearch", String(params.safesearch));
    if (params.engines) url.searchParams.set("engines", params.engines);

    const resp = await fetchWithRetry(
      url.toString(),
      { headers: { Accept: "application/json" } },
      signal,
    );

    if (!resp.ok) throw new Error(`SearxNG HTTP ${resp.status}: ${resp.statusText}`);
    return (await resp.json()) as SearxResponse;
  }
}

// ── Provider 2: Tavily ──────────────────────────────────────────────────

class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(params: SearchParams, signal: AbortSignal): Promise<SearxResponse> {
    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query: params.query,
      max_results: Math.min(params.limit, 20),
      search_depth: "basic",
      include_answer: "basic",
    };

    // Map categories to topic
    if (params.categories.includes("news")) body.topic = "news";
    if (params.categories.includes("finance")) body.topic = "finance";
    if (params.timeRange) body.time_range = params.timeRange;

    const resp = await fetchWithRetry(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      signal,
    );

    if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}: ${resp.statusText}`);

    const data = (await resp.json()) as {
      query: string;
      answer?: string;
      results: Array<{
        title: string;
        url: string;
        content: string;
        score?: number;
        published_date?: string;
      }>;
      response_time?: number;
    };

    const out = emptyResponse(params.query);
    out.number_of_results = data.results.length;

    if (data.answer) {
      out.answers.push({
        answer: data.answer,
        engine: "tavily",
        template: "answer",
      });
    }

    out.results = data.results.map((r, i) => ({
      url: r.url,
      title: stripHtml(r.title),
      content: stripHtml(r.content),
      engine: "tavily",
      score: r.score ?? 1.0 - i * 0.05,
      category: params.categories,
      engines: ["tavily"],
      positions: [i + 1],
    }));

    return out;
  }
}

// ── Provider 3: Brave Search ────────────────────────────────────────────

class BraveProvider implements SearchProvider {
  readonly name = "brave";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(params: SearchParams, signal: AbortSignal): Promise<SearxResponse> {
    // Choose endpoint based on categories
    const isNews = params.categories.includes("news");
    const base = isNews
      ? "https://api.search.brave.com/res/v1/news/search"
      : "https://api.search.brave.com/res/v1/web/search";

    const url = new URL(base);
    url.searchParams.set("q", params.query);
    url.searchParams.set("count", String(Math.min(params.limit, 20)));
    if (params.page > 1) url.searchParams.set("offset", String((params.page - 1) * params.limit));
    if (params.safesearch !== undefined) {
      url.searchParams.set("safesearch", params.safesearch === 0 ? "off" : params.safesearch === 1 ? "moderate" : "strict");
    }

    const resp = await fetchWithRetry(
      url.toString(),
      {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": this.apiKey,
        },
      },
      signal,
    );

    if (!resp.ok) throw new Error(`Brave HTTP ${resp.status}: ${resp.statusText}`);

    const data = (await resp.json()) as {
      query?: { original?: string };
      web?: {
        total_results?: number;
        results: Array<{
          title: string;
          url: string;
          description: string;
          age?: string;
          profile?: { name?: string };
          meta_url?: { favicon?: string };
        }>;
      };
      news?: {
        results: Array<{
          title: string;
          url: string;
          description: string;
          age?: string;
        }>;
      };
    };

    const results = isNews ? data.news?.results ?? [] : data.web?.results ?? [];
    const total = isNews ? results.length : (data.web?.total_results ?? results.length);

    const out = emptyResponse(params.query);
    out.number_of_results = total;

    out.results = results.map((r, i) => ({
      url: r.url,
      title: stripHtml(r.title),
      content: stripHtml(r.description),
      engine: "brave",
      score: 1.0 - i * 0.05,
      category: params.categories,
      engines: ["brave"],
      positions: [i + 1],
    }));

    return out;
  }
}

// ── Provider 4: DuckDuckGo HTML scraping ────────────────────────────────

class DuckDuckGoProvider implements SearchProvider {
  readonly name = "duckduckgo";

  async search(params: SearchParams, signal: AbortSignal): Promise<SearxResponse> {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", params.query);

    const resp = await fetchWithRetry(
      url.toString(),
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html",
        },
      },
      signal,
    );

    if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);

    const html = await resp.text();
    const out = emptyResponse(params.query);

    // Parse DDG HTML results
    // Each result: <div class="result">...<a class="result__a" href="...">title</a>...<a class="result__snippet">snippet</a>...</div>
    const resultBlocks = html.split(/<div[^>]*class="[^"]*result[^"]*"[^>]*>/gi).slice(1);

    for (const block of resultBlocks) {
      if (out.results.length >= params.limit) break;

      // Title + URL
      const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) continue;

      const rawUrl = titleMatch[1];
      const title = stripHtml(titleMatch[2]);
      const url = decodeDDGRedirect(rawUrl);

      // Snippet
      const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

      if (!title || !url) continue;

      out.results.push({
        url,
        title,
        content: snippet,
        engine: "duckduckgo",
        score: 1.0 - out.results.length * 0.1,
        category: params.categories,
        engines: ["duckduckgo"],
        positions: [out.results.length + 1],
      });
    }

    out.number_of_results = out.results.length;
    return out;
  }
}

// ── Provider 5: Raw (DDG Lite) ──────────────────────────────────────────

class RawProvider implements SearchProvider {
  readonly name = "raw";

  async search(params: SearchParams, signal: AbortSignal): Promise<SearxResponse> {
    const url = new URL("https://lite.duckduckgo.com/lite/");
    url.searchParams.set("q", params.query);

    const resp = await fetchWithRetry(
      url.toString(),
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html",
        },
      },
      signal,
    );

    if (!resp.ok) throw new Error(`Raw/DDG-Lite HTTP ${resp.status}`);

    const html = await resp.text();
    const out = emptyResponse(params.query);

    // DDG Lite format: <tr class="result-snippet"> for each result
    // Link: <a rel="nofollow" href="..."> or <a class="result-link" href="...">title</a>
    // Snippet: <td class="result-snippet">snippet</td>

    // Strategy: find all <a> tags with external hrefs (not duckduckgo.com internal)
    const linkPattern = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((m = linkPattern.exec(html)) !== null) {
      if (out.results.length >= params.limit) break;

      const rawUrl = m[1];
      const titleHtml = m[2];

      // Skip DDG internal links (but follow redirect ones)
      let resolvedUrl = rawUrl;
      if (rawUrl.includes("duckduckgo.com/l/")) {
        resolvedUrl = decodeDDGRedirect(rawUrl);
      }
      // Skip remaining DDG internal pages
      if (resolvedUrl.includes("duckduckgo.com") && !resolvedUrl.includes("uddg=")) continue;

      const title = stripHtml(titleHtml);
      if (!title || title.length < 3) continue;
      if (seen.has(resolvedUrl)) continue;
      seen.add(resolvedUrl);

      // Try to find a nearby snippet (look ahead in HTML)
      const posAfterLink = m.index + m[0].length;
      const nearbyHtml = html.slice(posAfterLink, posAfterLink + 1000);
      const snippetMatch = nearbyHtml.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

      out.results.push({
        url: resolvedUrl,
        title,
        content: snippet,
        engine: "duckduckgo-lite",
        score: 1.0 - out.results.length * 0.1,
        category: params.categories,
        engines: ["duckduckgo-lite"],
        positions: [out.results.length + 1],
      });
    }

    out.number_of_results = out.results.length;
    return out;
  }
}

// ── Provider factory ────────────────────────────────────────────────────

function createProvider(name: string, cfg: ProviderConfig, fullConfig?: WebSearchConfig): SearchProvider | null {
  switch (name) {
    case "searxng": {
      // Priority: unified searxngBaseUrl → legacy providers.searxng.baseUrl → env var → default
      const baseUrl = fullConfig?.searxngBaseUrl
        ?? cfg.baseUrl
        ?? process.env.SEARXNG_URL
        ?? process.env.SEARXNG_BASE_URL
        ?? "http://192.168.50.222:8080";
      return new SearxNGProvider(baseUrl);
    }
    case "tavily": {
      const apiKey = cfg.apiKey ?? process.env.TAVILY_API_KEY ?? "";
      if (!apiKey) return null;
      return new TavilyProvider(apiKey);
    }
    case "brave": {
      const apiKey = cfg.apiKey ?? process.env.BRAVE_API_KEY ?? "";
      if (!apiKey) return null;
      return new BraveProvider(apiKey);
    }
    case "duckduckgo":
      return new DuckDuckGoProvider();
    case "raw":
      return new RawProvider();
    default:
      return null;
  }
}

// ── Cache ───────────────────────────────────────────────────────────────

interface CacheEntry {
  text: string;
  details: Record<string, unknown>;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 50;

function cacheKey(params: SearchParams): string {
  return [
    params.query,
    params.categories,
    params.language,
    params.timeRange ?? "",
    params.safesearch ?? -1,
    params.page,
    params.engines ?? "",
    params.limit,
  ].join("|||");
}

// ── Extension ───────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI) {
  // ── Conflict detection ───────────────────────────────────────
  // If another extension (e.g. pi-web-access) already registered
  // "web_search", skip registration silently instead of crashing.
  try {
    pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using a configured provider (SearxNG, Tavily, Brave, " +
      "DuckDuckGo, or raw scraping). Returns titles, URLs, and snippets. " +
      "Supports language filtering, time range, safe search, and pagination. " +
      "No API key needed for DuckDuckGo/raw — works out of the box. " +
      "Configure provider via ~/.pi/web-search.json.",

    promptSnippet:
      "Search the web — returns titles, URLs, and snippets from configured provider",

    promptGuidelines: [
      "Use web_search for any question about current events, recent " +
      "documentation, or facts outside your training cutoff.",
      "Prefer web_search when the user asks 'search for X' or 'look up Y'.",
      "After getting results, synthesize them — don't just paste the snippets.",
      "Use the `language` parameter for results in a specific language.",
      "Use `time_range` ('day', 'week', 'month', 'year') for news/time-sensitive queries.",
      "Use `page` for pagination when you need more than the first batch.",
      "Use `categories: \"news\"` for news results; `\"it\"` for tech/code.",
    ],

    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query string. Use concise, keyword-focused queries. " +
          "Supports site:domain.com and \"exact phrase\" syntax.",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum results (1–15, default 8).",
          minimum: 1,
          maximum: 15,
        })
      ),
      categories: Type.Optional(
        Type.String({
          description:
            "Comma-separated: general, news, images, videos, music, it, " +
            "science, files, social media, map. Default: 'general'.",
        })
      ),
      engines: Type.Optional(
        Type.String({
          description:
            "Comma-separated engine names (e.g. 'google,stackoverflow'). " +
            "Only supported by SearxNG provider.",
        })
      ),
      language: Type.Optional(
        Type.String({
          description:
            "Language code: 'en', 'it', 'fr', 'de', 'es', 'all'. Default: 'all'.",
        })
      ),
      time_range: Type.Optional(
        Type.String({
          description:
            "Filter by time: 'day', 'week', 'month', 'year'. For news/events.",
        })
      ),
      safesearch: Type.Optional(
        Type.Number({
          description: "Safe search: 0 (off), 1 (moderate), 2 (strict).",
          minimum: 0,
          maximum: 2,
        })
      ),
      page: Type.Optional(
        Type.Number({
          description: "Page number (1-based). Default: 1.",
          minimum: 1,
          maximum: 10,
        })
      ),
      noCache: Type.Optional(
        Type.Boolean({
          description: "Bypass cache for a fresh search. Default: false.",
          default: false,
        })
      ),
    }),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as {
        query: string;
        limit?: number;
        categories?: string;
        engines?: string;
        language?: string;
        time_range?: string;
        safesearch?: number;
        page?: number;
        noCache?: boolean;
      };

      const searchParams: SearchParams = {
        query: params.query,
        limit: params.limit ?? 8,
        categories: params.categories ?? "general",
        engines: params.engines,
        language: params.language ?? "all",
        timeRange: params.time_range,
        safesearch: params.safesearch,
        page: params.page ?? 1,
      };

      // ── Cache check ───────────────────────────────────────────

      const ck = cacheKey(searchParams);
      if (!params.noCache && cache.has(ck)) {
        const entry = cache.get(ck)!;
        const age = Math.round((Date.now() - entry.fetchedAt) / 1000);
        return {
          content: [{ type: "text", text: `[cache · ${age}s ago]\n\n${entry.text}` }],
          details: { ...entry.details, cached: true, cacheAgeSec: age },
        };
      }

      // ── Load config ───────────────────────────────────────────

      const config = loadConfig();
      const chain = config?.fallbackChain ?? ["searxng", "duckduckgo", "raw"];
      let finalProviderName = "unknown";
      let lastError: string | null = null;

      // ── Try providers in fallback chain ───────────────────────

      let response: SearxResponse | null = null;

      for (const providerName of chain) {
        if (signal.aborted) break;

        const pcfg = config?.providers?.[providerName] ?? {};
        const provider = createProvider(providerName, pcfg, config ?? undefined);

        if (!provider) {
          lastError = `Provider "${providerName}": not configured (missing API key or URL)`;
          continue;
        }

        try {
          response = await provider.search(searchParams, signal as AbortSignal);
          finalProviderName = providerName;
          lastError = null;
          break; // success — stop fallback chain
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = `Provider "${providerName}": ${msg}`;
          // Continue to next provider in chain
        }
      }

      // ── All providers failed ─────────────────────────────────

      if (!response) {
        const providerList = chain.join(" → ");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `All search providers failed.\n` +
                `Chain tried: ${providerList}\n` +
                `Last error: ${lastError ?? "unknown"}\n\n` +
                `Configure a provider in ${CONFIG_PATH} or set env vars:\n` +
                `- SEARXNG_URL for a self-hosted SearxNG instance\n` +
                `- TAVILY_API_KEY for Tavily (AI-optimized search)\n` +
                `- BRAVE_API_KEY for Brave Search (2000 req/month free)\n` +
                `- Or ensure DuckDuckGo scraping is enabled in config.`,
            },
          ],
          details: {
            query: params.query,
            chain,
            lastError,
            configPath: CONFIG_PATH,
          },
        };
      }

      // ── Format output ────────────────────────────────────────

      const results = response.results.slice(0, searchParams.limit);
      const lines: string[] = [];

      // Summary header
      const totalResults = response.number_of_results ?? response.results.length;
      const summaryParts: string[] = [
        `**Search:** "${response.query}"`,
        `${totalResults.toLocaleString()} total results`,
        `**Provider:** ${finalProviderName}`,
      ];
      if (searchParams.page > 1) summaryParts.push(`page ${searchParams.page}`);
      if (searchParams.timeRange) summaryParts.push(`past ${searchParams.timeRange}`);
      if (searchParams.language !== "all") summaryParts.push(`lang: ${searchParams.language}`);
      if (response.corrections.length > 0) {
        summaryParts.push(`**Correction:** ${response.corrections.join(", ")}`);
      }
      lines.push(summaryParts.join("  •  "));

      // Answers
      if (response.answers.length > 0) {
        lines.push(`\n### Instant Answers`);
        for (const ans of response.answers) {
          lines.push(`> **${ans.engine}:** ${stripHtml(ans.answer)}`);
        }
      }

      // Infoboxes
      if (response.infoboxes.length > 0) {
        for (const ibox of response.infoboxes) {
          const title = ibox.title ? stripHtml(ibox.title) : stripHtml(ibox.infobox || "");
          const content = stripHtml(ibox.content || "");
          lines.push(`\n### ${title || "Info Box"}`);
          if (content) lines.push(`${content}`);
          if (ibox.url) lines.push(`\n**Source:** ${ibox.url}`);
          if (ibox.img_src) lines.push(`**Image:** ${ibox.img_src}`);
        }
      }

      // Suggestions
      if (response.suggestions.length > 0) {
        lines.push(`\n**Suggestions:** ${response.suggestions.map((s) => `"${s}"`).join(", ")}`);
      }

      // Results
      if (results.length > 0) {
        lines.push(`\n---\n`);
        lines.push(`### Results (showing ${results.length} of ${totalResults})\n`);
        const formatted = results
          .map((r, i) => {
            const title = stripHtml(r.title) || "(no title)";
            const snippet = stripHtml(r.content);
            const source = (r.engines ?? [r.engine]).join(", ").replace(/_/g, " ");
            return [
              `## ${i + 1}. ${title}`,
              `- **URL:** ${r.url}`,
              `- **Source(s):** ${source}`,
              snippet ? `- ${snippet}` : "",
            ].filter(Boolean).join("\n");
          })
          .join("\n\n---\n\n");
        lines.push(formatted);
      } else if (response.answers.length === 0 && response.infoboxes.length === 0) {
        lines.push(`\n*No results found.*`);
      }

      // Unresponsive engines note
      if (response.unresponsive_engines.length > 0) {
        const failed = response.unresponsive_engines
          .map(([name, reason]) => `${name} (${reason})`)
          .join(", ");
        lines.push(`\n> *Note: some engines unavailable: ${failed}*`);
      }

      const text = lines.join("\n");

      // ── Cache ────────────────────────────────────────────────

      if (!params.noCache) {
        cache.set(ck, {
          text,
          details: {
            query: response.query,
            totalResults: totalResults,
            returnedResults: results.length,
            provider: finalProviderName,
            fallbackChain: chain,
            page: searchParams.page,
            timeRange: searchParams.timeRange ?? null,
            language: searchParams.language === "all" ? null : searchParams.language,
            answersCount: response.answers.length,
            infoboxesCount: response.infoboxes.length,
            corrections: response.corrections,
            suggestions: response.suggestions,
          },
          fetchedAt: Date.now(),
        });
        if (cache.size > MAX_CACHE_SIZE) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
      }

      return {
        content: [{ type: "text", text }],
        details: {
          query: response.query,
          totalResults: totalResults,
          returnedResults: results.length,
          provider: finalProviderName,
          fallbackChain: chain,
          page: searchParams.page,
          timeRange: searchParams.timeRange ?? null,
          language: searchParams.language === "all" ? null : searchParams.language,
          answersCount: response.answers.length,
          infoboxesCount: response.infoboxes.length,
          corrections: response.corrections,
          suggestions: response.suggestions,
          cached: false,
        },
      };
    },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("conflicts with") || msg.includes("already registered")) {
      console.error(
        `[pi-toolkit] web_search NOT registered: another extension already owns this tool.\n` +
        `  This is expected if pi-web-access is installed — it provides a more capable web_search.\n` +
        `  To use pi-toolkit's web_search instead, uninstall pi-web-access:\n` +
        `    pi uninstall git:github.com/nicobailon/pi-web-access\n` +
        `  Then reload pi.`
      );
      // Continue without web_search — pi-web-access handles it.
      return;
    }
    throw err;
  }

  // ── Session start: auto-detect / setup wizard ─────────────────────

  pi.on("session_start", async (_event, ctx) => {
    cache.clear();

    const config = loadConfig();
    if (config) {
      // Config exists — quick health check on primary provider
      const primary = resolveProviderName(config);
      const pcfg = config.providers?.[primary] ?? {};
      const provider = createProvider(primary, pcfg, config);

      if (provider) {
        // Test with a lightweight query
        provider
          .search({ query: "test", limit: 1, categories: "general", language: "all", page: 1 }, AbortSignal.timeout(5000))
          .then(() => {
            ctx.ui.notify(`Web Search v3.1: "${primary}" ready`, "info");
          })
          .catch((err: Error) => {
            ctx.ui.notify(
              `Web Search v3.1: "${primary}" unreachable (${err.message}). Fallback chain: ${config.fallbackChain.join(" → ")}`,
              "warning"
            );
          });
      } else {
        ctx.ui.notify(
          `Web Search v3.1: provider "${primary}" not configured. Check ${CONFIG_PATH}`,
          "warning"
        );
      }
      return;
    }

    // ── No config: auto-detect ─────────────────────────────────

    // 1. Check SEARXNG_URL env var
    const envUrl = process.env.SEARXNG_URL;
    if (envUrl) {
      const testProv = new SearxNGProvider(envUrl);
      try {
        await testProv.search(
          { query: "test", limit: 1, categories: "general", language: "all", page: 1 },
          AbortSignal.timeout(5000),
        );
        // SearxNG reachable via env var → create config
        saveConfig({
          searchProvider: "searxng",
          searxngBaseUrl: envUrl,
          fallbackChain: ["searxng", "duckduckgo", "raw"],
          providers: {
            duckduckgo: { enabled: true },
            raw: { enabled: true },
          },
        });
        ctx.ui.notify(`Web Search v3.1: auto-configured SearxNG at ${envUrl}`, "info");
        return;
      } catch { /* env var instance not reachable */ }
    }

    // 2. Check common localhost SearxNG ports
    const localhostCandidates = [
      "http://192.168.50.222:8080",
      "http://localhost:8080",
      "http://localhost:8888",
      "http://127.0.0.1:8080",
    ];
    for (const candidate of localhostCandidates) {
      const testProv = new SearxNGProvider(candidate);
      try {
        await testProv.search(
          { query: "test", limit: 1, categories: "general", language: "all", page: 1 },
          AbortSignal.timeout(3000),
        );
        // Found!
        saveConfig({
          searchProvider: "searxng",
          searxngBaseUrl: candidate,
          fallbackChain: ["searxng", "duckduckgo", "raw"],
          providers: {
            duckduckgo: { enabled: true },
            raw: { enabled: true },
          },
        });
        ctx.ui.notify(`Web Search v3.1: auto-detected SearxNG at ${candidate}`, "info");
        return;
      } catch { /* not reachable */ }
    }

    // 3. No SearxNG found → check for API keys, then fallback to DuckDuckGo
    const tavilyKey = process.env.TAVILY_API_KEY;
    const braveKey = process.env.BRAVE_API_KEY;

    if (tavilyKey || braveKey) {
      const provider = tavilyKey ? "tavily" : "brave";
      saveConfig({
        searchProvider: provider,
        fallbackChain: [provider, "duckduckgo", "raw"],
        providers: {
          [provider]: { apiKey: tavilyKey || braveKey },
          duckduckgo: { enabled: true },
          raw: { enabled: true },
        },
      });
      ctx.ui.notify(`Web Search v3.1: auto-configured ${provider} (API key from env)`, "info");
      return;
    }

    // 4. Absolute fallback: DuckDuckGo scraping (zero config needed)
    saveConfig({
      searchProvider: "duckduckgo",
      fallbackChain: ["duckduckgo", "raw"],
      providers: {
        duckduckgo: { enabled: true },
        raw: { enabled: true },
      },
    });
    ctx.ui.notify(
      "Web Search v3.1: using DuckDuckGo scraping (free, no API keys). " +
      `To switch provider, edit ${CONFIG_PATH}`,
      "info"
    );
  });
}
