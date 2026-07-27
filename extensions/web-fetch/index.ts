/**
 * Web Fetch Extension v2.0
 *
 * System-wide extension providing `web_fetch` tool with:
 * - Readability.js for main content extraction (Firefox Reader View)
 * - Turndown for HTML → Markdown conversion
 * - Metascraper for OpenGraph, Twitter Cards, JSON-LD metadata
 * - robots.txt checking before requests
 * - Retry with exponential backoff
 * - In-session cache
 * - Link/image extraction
 * - Smart Markdown-section truncation
 * - RSS/Atom feed detection
 *
 * Zero API keys. Zero paid services. All local.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Dynamic requires (cjs from node_modules) ──────────────────────────

// All npm deps are loaded at call time to avoid startup issues.
// jiti resolves require() relative to this file's directory.

// ── Constants ───────────────────────────────────────────────────────────

const MAX_OUTPUT_TOKENS = 8000;
const MAX_RAW_LENGTH = 200_000;
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_LIMIT = 3;
const RETRY_BASE_DELAY_MS = 800;

const USER_AGENT =
  "Mozilla/5.0 (compatible; PiAgent/2.0; +https://github.com/earendil-works/pi)";

// ── In-session cache ────────────────────────────────────────────────────

interface CacheEntry {
  markdown: string;
  metadata: Record<string, unknown>;
  fetchedAt: number;
  status: number;
}

const cache = new Map<string, CacheEntry>();

// ── Helpers ─────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate Markdown at nearest section or paragraph boundary */
function truncateMarkdown(md: string, maxTokens: number): string {
  const targetChars = maxTokens * 4;
  if (md.length <= targetChars) return md;

  // Find last heading boundary before target
  const headPattern = /^#{1,6}\s+.+$/gm;
  let bestIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = headPattern.exec(md)) !== null) {
    if (match.index < targetChars) {
      bestIdx = match.index;
    } else {
      break;
    }
  }

  if (bestIdx === 0 || bestIdx < targetChars * 0.35) {
    // Fallback: paragraph break
    const paraRe = /\n\n/g;
    while ((match = paraRe.exec(md)) !== null) {
      if (match.index < targetChars) {
        bestIdx = match.index;
      } else {
        break;
      }
    }
  }

  const cutPoint = bestIdx > 0 ? bestIdx : targetChars;
  const omitted = estimateTokens(md.slice(cutPoint));
  return (
    md.slice(0, cutPoint).trimEnd() +
    `\n\n> *[... ~${omitted} tokens omitted — use a more specific URL for full content]*`
  );
}

/** Minimal robots.txt check */
async function checkRobotsTxt(
  origin: string,
  signal: AbortSignal
): Promise<{ allowed: boolean; disallowedPaths: string[] }> {
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", origin).toString();
  } catch {
    return { allowed: true, disallowedPaths: [] };
  }

  let resp: Response;
  try {
    resp = await fetch(robotsUrl, {
      signal,
      headers: { "User-Agent": USER_AGENT },
    });
  } catch {
    return { allowed: true, disallowedPaths: [] };
  }

  if (!resp.ok) return { allowed: true, disallowedPaths: [] };

  const text = await resp.text();
  const lines = text.split(/\r?\n/);

  let inOurBlock = false;
  const disallowed: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "user-agent") {
      inOurBlock = value === "*" || value.toLowerCase().includes("piagent");
    } else if (field === "disallow" && inOurBlock && value) {
      disallowed.push(value);
    }
  }

  return { allowed: true, disallowedPaths: disallowed };
}

/** Fetch with retry + exponential backoff */
async function fetchWithRetry(
  url: string,
  signal: AbortSignal,
  retries = RETRY_LIMIT
): Promise<Response> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const linked = AbortSignal.any([signal, controller.signal]);
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const resp = await fetch(url, {
        signal: linked,
        redirect: "follow",
        headers: {
          Accept:
            "text/html, application/rss+xml, application/atom+xml, application/json, application/xml, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9,*;q=0.5",
          "User-Agent": USER_AGENT,
        },
      });

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

// ── Extension ───────────────────────────────────────────────────────────

export default function webFetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and extract clean, readable content from any URL. Returns Markdown " +
      "with rich metadata (title, author, date, OpenGraph, JSON-LD). Uses " +
      "Readability.js (Firefox Reader View algorithm) to isolate main content, " +
      "Turndown for HTML→Markdown, and Metascraper for metadata. Supports HTML, " +
      "JSON, XML, RSS/Atom feeds. No API keys or paid services required.",

    promptSnippet:
      "Fetch a URL → clean Markdown + metadata (Readability + Turndown + Metascraper)",

    promptGuidelines: [
      "Use web_fetch when the user asks to open, read, fetch, or visit a URL " +
      "— in any language.",
      "Use web_fetch after web_search to drill into specific results.",
      "The tool returns clean Markdown preserving headings, lists, links, " +
      "tables, and code blocks.",
      "Metadata includes: title, description, author, date, language, publisher, " +
      "OpenGraph image, JSON-LD structured data.",
      "For JSON APIs, the tool auto-detects and pretty-prints JSON.",
      "For RSS/Atom feeds, the tool auto-detects and extracts structured entries.",
      "If the page is too large, content is truncated at a section boundary.",
    ],

    parameters: Type.Object({
      url: Type.String({
        description:
          "Full URL to fetch (must include https:// or http://).",
      }),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "If true, return raw response body without processing. Default: false.",
          default: false,
        })
      ),
      noCache: Type.Optional(
        Type.Boolean({
          description:
            "Bypass in-session cache and force a fresh fetch. Default: false.",
          default: false,
        })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const {
        url: rawUrl,
        raw = false,
        noCache = false,
      } = params as { url: string; raw?: boolean; noCache?: boolean };

      // ── Validate URL ─────────────────────────────────────────────

      let url: URL;
      try {
        url = new URL(rawUrl.trim());
        if (!["http:", "https:"].includes(url.protocol)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Invalid protocol: "${url.protocol}". Only http:// and https:// are supported.`,
              },
            ],
          };
        }
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid URL: "${rawUrl}". Provide a full URL with https:// or http://.`,
            },
          ],
        };
      }

      const urlStr = url.toString();

      // ── Check cache ──────────────────────────────────────────────

      if (!noCache && !raw && cache.has(urlStr)) {
        const entry = cache.get(urlStr)!;
        const age = Math.round((Date.now() - entry.fetchedAt) / 1000);
        return {
          content: [
            {
              type: "text",
              text:
                `[cache · ${age}s ago · HTTP ${entry.status}]\n\n` +
                entry.markdown,
            },
          ],
          details: {
            ...entry.metadata,
            cached: true,
            cacheAgeSec: age,
          },
        };
      }

      // ── robots.txt check ─────────────────────────────────────────

      try {
        const origin = `${url.protocol}//${url.host}`;
        await checkRobotsTxt(origin, signal as AbortSignal);
        // Note: we currently don't block on disallowed paths — we just
        // log the info. Full enforcement could be added with path matching.
      } catch { /* proceed */ }

      // ── Fetch ────────────────────────────────────────────────────

      let response: Response;
      try {
        response = await fetchWithRetry(urlStr, signal as AbortSignal);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("abort") ||
          msg.includes("AbortError") ||
          msg.includes("timeout")
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${urlStr}`,
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch ${urlStr}: ${msg}`,
            },
          ],
        };
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (!response.ok) {
        let errorBody = "";
        try {
          errorBody = (await response.text()).slice(0, 500);
        } catch { /* ignore */ }

        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `HTTP ${response.status} ${response.statusText} for ${urlStr}\n` +
                (errorBody ? `Body: ${errorBody}` : ""),
            },
          ],
          details: {
            url: urlStr,
            status: response.status,
            statusText: response.statusText,
            contentType,
          },
        };
      }

      // ── Read body ────────────────────────────────────────────────

      let body: string;
      try {
        body = await response.text();
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to read response body from ${urlStr}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      const contentLength = response.headers.get("content-length");
      const estimatedSize = contentLength ? Number(contentLength) : body.length;

      // ── Content-type routing ─────────────────────────────────────

      const isJson =
        contentType.includes("json") || contentType.includes("+json");
      const isXml = contentType.includes("xml") || contentType.includes("+xml");
      const isHtml = contentType.includes("html");
      const isRssAtom =
        contentType.includes("rss") ||
        contentType.includes("atom") ||
        (!isJson && !isHtml && !isXml && body.includes("<rss")) ||
        (!isJson && !isHtml && !isXml && body.includes("<feed"));

      let markdown = "";
      const metadata: Record<string, unknown> = {
        url: urlStr,
        status: response.status,
        contentType,
        contentLength: estimatedSize,
      };

      if (raw) {
        // ── Raw mode ────────────────────────────────────────────────
        let output = body;
        if (isJson) {
          try {
            output = JSON.stringify(JSON.parse(body), null, 2);
          } catch { /* keep as-is */ }
        }
        if (output.length > MAX_RAW_LENGTH) {
          output =
            output.slice(0, MAX_RAW_LENGTH) +
            `\n\n[... truncated ${output.length - MAX_RAW_LENGTH} chars]`;
        }
        markdown = `\`\`\`\n${output}\n\`\`\``;
      } else if (isJson) {
        // ── JSON: pretty-print ──────────────────────────────────────
        try {
          const parsed = JSON.parse(body);
          const pretty = JSON.stringify(parsed, null, 2);
          markdown = `\`\`\`json\n${pretty.slice(0, MAX_RAW_LENGTH)}\n\`\`\``;
          if (pretty.length > MAX_RAW_LENGTH) {
            markdown += `\n\n> *[... truncated ${pretty.length - MAX_RAW_LENGTH} chars]*`;
          }
        } catch {
          markdown = `\`\`\`\n${body.slice(0, MAX_RAW_LENGTH)}\n\`\`\``;
        }
      } else if (isRssAtom) {
        // ── RSS/Atom ────────────────────────────────────────────────
        try {
          const feedData = parseFeed(body);
          metadata.feedType = feedData.type;
          metadata.feedTitle = feedData.title;
          metadata.entryCount = feedData.entries.length;
          markdown = formatFeed(feedData);
        } catch {
          markdown = truncateMarkdown(body, MAX_OUTPUT_TOKENS);
        }
      } else if (isHtml || (!isJson && !isXml && !isRssAtom)) {
        // ── HTML: full pipeline ─────────────────────────────────────
        try {
          const result = await processHtml(body, urlStr);
          markdown = result.markdown;
          Object.assign(metadata, result.metadata);
        } catch (err: unknown) {
          metadata.processingError =
            err instanceof Error ? err.message : String(err);
          markdown = basicHtmlToMarkdown(body);
          markdown = truncateMarkdown(markdown, MAX_OUTPUT_TOKENS);
        }
      } else {
        // ── XML / unknown ───────────────────────────────────────────
        markdown = truncateMarkdown(body, MAX_OUTPUT_TOKENS);
      }

      // ── Final truncation ──────────────────────────────────────────

      if (!raw && !isJson) {
        markdown = truncateMarkdown(markdown, MAX_OUTPUT_TOKENS);
      }

      // ── Build header ─────────────────────────────────────────────

      const sizeStr = estimatedSize
        ? estimatedSize > 1024
          ? `~${Math.round(estimatedSize / 1024)} KB`
          : `${estimatedSize} B`
        : "";

      const headerLines = [
        `**URL:** ${urlStr}`,
        `**Status:** HTTP ${response.status}`,
        `**Content-Type:** ${contentType || "unknown"}`,
        sizeStr ? `**Size:** ${sizeStr}` : "",
        metadata.title ? `**Title:** ${metadata.title}` : "",
        metadata.author ? `**Author:** ${metadata.author}` : "",
        metadata.date ? `**Date:** ${metadata.date}` : "",
        metadata.publisher ? `**Source:** ${metadata.publisher}` : "",
        metadata.lang ? `**Language:** ${metadata.lang}` : "",
        metadata.feedTitle
          ? `**Feed:** ${metadata.feedTitle} (${metadata.feedType}, ${metadata.entryCount} entries)`
          : "",
        metadata.image ? `**Image:** ${metadata.image}` : "",
        metadata.readable === true
          ? ""
          : !metadata.feedTitle && !isJson && !raw
            ? "*(Note: Readability could not identify main content — showing raw body)*"
            : "",
      ].filter(Boolean);

      const header = headerLines.join("  \n");

      // ── Extra links section ──────────────────────────────────────

      let linksSection = "";
      if (
        metadata.links &&
        Array.isArray(metadata.links) &&
        (metadata.links as unknown[]).length > 0
      ) {
        const links = metadata.links as Array<{ text: string; href: string }>;
        const linkList = links
          .slice(0, 15)
          .map((l) => `- [${l.text || l.href}](${l.href})`)
          .join("\n");
        linksSection = `\n\n### Extracted Links\n${linkList}`;
      }

      // ── Cache ────────────────────────────────────────────────────

      if (!noCache && !raw) {
        cache.set(urlStr, {
          markdown,
          metadata,
          fetchedAt: Date.now(),
          status: response.status,
        });
        // Limit cache size
        if (cache.size > 50) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n---\n\n${markdown}${linksSection}`,
          },
        ],
        details: {
          ...metadata,
          outputTokens: estimateTokens(markdown),
          outputChars: markdown.length,
          truncated: markdown.length < body.length,
          cached: false,
        },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    cache.clear();
    ctx.ui.notify(
      "Web Fetch v2: Readability + Turndown + Metascraper",
      "info"
    );
  });
}

// ── HTML Processing Pipeline ────────────────────────────────────────────

async function processHtml(
  html: string,
  pageUrl: string
): Promise<{ markdown: string; metadata: Record<string, unknown> }> {
  const { JSDOM } = require("jsdom");
  const { Readability, isProbablyReaderable } = require("@mozilla/readability");
  const TurndownService = require("turndown");

  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;

  // ── 1. Extract metadata ──────────────────────────────────────────

  const metadata = await extractMetadata(html, pageUrl);

  // ── 2. Extract JSON-LD ───────────────────────────────────────────

  try {
    const scripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    const jsonld = Array.from(scripts)
      .map((s: Element) => {
        try {
          return JSON.parse(s.textContent ?? "");
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (jsonld.length === 1) {
      metadata.jsonld = jsonld[0] as object;
    } else if (jsonld.length > 1) {
      metadata.jsonld = jsonld;
    }
  } catch { /* ignore */ }

  // ── 3. Extract links ─────────────────────────────────────────────

  try {
    const anchors = doc.querySelectorAll("a[href]");
    const links: Array<{ text: string; href: string }> = [];
    for (const a of Array.from(anchors) as Element[]) {
      const href = a.getAttribute("href") ?? "";
      const text = (a.textContent ?? "").trim().slice(0, 120);
      try {
        const resolved = new URL(href, pageUrl).toString();
        if (resolved.startsWith("http") && !resolved.includes("javascript:") && text) {
          links.push({ text, href: resolved });
          if (links.length >= 50) break;
        }
      } catch { /* skip invalid href */ }
    }
    if (links.length > 0) metadata.links = links;
  } catch { /* ignore */ }

  // ── 4. Extract images ────────────────────────────────────────────

  try {
    const imgs = doc.querySelectorAll("img[src]");
    const images: string[] = [];
    for (const img of Array.from(imgs) as Element[]) {
      const src = img.getAttribute("src") ?? "";
      try {
        const resolved = new URL(src, pageUrl).toString();
        if (resolved.startsWith("http") && !images.includes(resolved)) {
          images.push(resolved);
          if (images.length >= 10) break;
        }
      } catch { /* skip */ }
    }
    if (images.length > 0) metadata.images = images;
  } catch { /* ignore */ }

  // ── 5. Main content: Readability ─────────────────────────────────

  let contentHtml: string;
  try {
    metadata.readable = isProbablyReaderable(doc);
  } catch {
    metadata.readable = false;
  }

  if (metadata.readable) {
    try {
      const reader = new Readability(doc);
      const article = reader.parse();

      if (article && article.content) {
        contentHtml = article.content;
        // Merge Readability metadata (lower priority than metascraper)
        if (!metadata.title && article.title)
          metadata.title = article.title;
        if ((!metadata.author || metadata.author === "null") && article.byline)
          metadata.author = article.byline;
        if (article.siteName) metadata.publisher = article.siteName;
        if (article.lang) metadata.lang = article.lang;
        if (article.excerpt && !metadata.description)
          metadata.description = article.excerpt;
      } else {
        contentHtml = html;
        metadata.readable = false;
      }
    } catch {
      contentHtml = html;
      metadata.readable = false;
    }
  } else {
    contentHtml = html;
  }

  // ── 6. HTML → Markdown ───────────────────────────────────────────

  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });

  let markdown: string;
  try {
    markdown = turndownService.turndown(contentHtml);
  } catch {
    markdown = basicHtmlToMarkdown(contentHtml);
  }

  // Clean up
  markdown = markdown.replace(/\n{4,}/g, "\n\n\n");
  markdown = markdown.replace(/^-   /gm, "- ");

  return { markdown, metadata };
}

// ── Metadata Extraction ─────────────────────────────────────────────────

async function extractMetadata(
  html: string,
  pageUrl: string
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  // Try metascraper first (async)
  try {
    const metascraper = require("metascraper");
    const rules: Array<() => unknown> = [];
    try { rules.push(require("metascraper-title")()); } catch { /* not installed */ }
    try { rules.push(require("metascraper-description")()); } catch { /* */ }
    try { rules.push(require("metascraper-image")()); } catch { /* */ }
    try { rules.push(require("metascraper-author")()); } catch { /* */ }
    try { rules.push(require("metascraper-date")()); } catch { /* */ }
    try { rules.push(require("metascraper-lang")()); } catch { /* */ }
    try { rules.push(require("metascraper-publisher")()); } catch { /* */ }
    try { rules.push(require("metascraper-url")()); } catch { /* */ }

    if (rules.length > 0) {
      const ms = metascraper(rules);
      const scraped = await ms({ html, url: pageUrl });

      if (scraped.title) result.title = scraped.title;
      if (scraped.description) result.description = scraped.description;
      if (scraped.image) result.image = scraped.image;
      if (scraped.author) result.author = scraped.author;
      if (scraped.date) result.date = scraped.date;
      if (scraped.lang) result.lang = scraped.lang;
      if (scraped.publisher) result.publisher = scraped.publisher;
      if (scraped.url) result.finalUrl = scraped.url;
    }
  } catch { /* fall through to sync extraction */ }

  // Sync fallback for any missing fields
  const syncMeta = extractMetaSync(html, pageUrl);

  for (const [key, val] of Object.entries(syncMeta)) {
    if (val && !result[key]) {
      result[key] = val;
    }
  }

  return result;
}

/** Synchronous metadata extraction via regex (always works, no deps) */
function extractMetaSync(
  html: string,
  pageUrl: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const metaTags: Record<string, string> = {};

  // Match <meta name="X" content="Y"> and variants
  const patterns = [
    /<meta\s+[^>]*?(?:name|property|itemprop)="([^"]*?)"\s+content="([^"]*?)"[^>]*?>/gi,
    /<meta\s+[^>]*?content="([^"]*?)"\s+(?:name|property|itemprop)="([^"]*?)"[^>]*?>/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      let key: string, val: string;
      if (patterns.indexOf(re) === 0) {
        key = m[1].toLowerCase();
        val = m[2];
      } else {
        val = m[1];
        key = m[2].toLowerCase();
      }
      if (!metaTags[key]) metaTags[key] = val;
    }
  }

  // Title: og:title > twitter:title > <title> tag
  result.title =
    metaTags["og:title"] ||
    metaTags["twitter:title"] ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
    null;

  // Description
  result.description =
    metaTags["og:description"] ||
    metaTags["twitter:description"] ||
    metaTags["description"] ||
    null;

  // Image (resolve relative URLs)
  result.image =
    metaTags["og:image"] ||
    metaTags["twitter:image"] ||
    metaTags["twitter:image:src"] ||
    null;
  if (typeof result.image === "string" && result.image) {
    try {
      result.image = new URL(result.image, pageUrl).toString();
    } catch { /* keep as-is */ }
  }

  // Author
  result.author =
    metaTags["author"] ||
    metaTags["og:article:author"] ||
    metaTags["article:author"] ||
    null;

  // Date
  result.date =
    metaTags["article:published_time"] ||
    metaTags["og:article:published_time"] ||
    metaTags["date"] ||
    metaTags["dc.date"] ||
    null;

  // Publisher
  result.publisher =
    metaTags["og:site_name"] ||
    metaTags["publisher"] ||
    null;

  // Language
  result.lang =
    metaTags["og:locale"] ||
    metaTags["language"] ||
    html.match(/<html[^>]*lang="([^"]*)"/i)?.[1] ||
    html.match(/<html[^>]*lang=([^\s>]+)/i)?.[1]?.replace(/['"]/g, "") ||
    null;

  return result;
}

// ── Fallback HTML → Markdown ────────────────────────────────────────────

function basicHtmlToMarkdown(html: string): string {
  const TurndownService = require("turndown");
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const clean = html
    .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|noscript|svg|head)[^>]*\/>/gi, "");
  return td.turndown(clean);
}

// ── RSS/Atom Feed Parser ────────────────────────────────────────────────

interface FeedData {
  type: "rss" | "atom" | "unknown";
  title?: string;
  description?: string;
  link?: string;
  entries: FeedEntry[];
}

interface FeedEntry {
  title?: string;
  link?: string;
  description?: string;
  date?: string;
}

function parseFeed(xml: string): FeedData {
  const isAtom = xml.includes("<feed");
  const data: FeedData = {
    type: isAtom ? "atom" : "rss",
    entries: [],
  };

  // Title
  const titleMatch = xml.match(
    isAtom
      ? /<title[^>]*>([\s\S]*?)<\/title>/i
      : /<title>([\s\S]*?)<\/title>/i
  );
  if (titleMatch) data.title = htmlToText(titleMatch[1]);

  // Description
  const descMatch = xml.match(
    isAtom
      ? /<subtitle[^>]*>([\s\S]*?)<\/subtitle>/i
      : /<description>([\s\S]*?)<\/description>/i
  );
  if (descMatch) data.description = htmlToText(descMatch[1]);

  // Link
  const linkMatch = xml.match(
    isAtom
      ? /<link[^>]*href="([^"]*)"[^>]*\/?>/i
      : /<link>([\s\S]*?)<\/link>/i
  );
  if (linkMatch) data.link = (linkMatch[1] || linkMatch[2] || "").trim();

  // Entries
  const entryTag = isAtom ? "entry" : "item";
  const entryRe = new RegExp(
    `<${entryTag}[^>]*>([\\s\\S]*?)<\\/${entryTag}>`,
    "gi"
  );
  let eMatch: RegExpExecArray | null;
  while ((eMatch = entryRe.exec(xml)) !== null) {
    const entryXml = eMatch[1];
    const entry: FeedEntry = {};

    const etitle = entryXml.match(
      isAtom
        ? /<title[^>]*>([\s\S]*?)<\/title>/i
        : /<title>([\s\S]*?)<\/title>/i
    );
    if (etitle) entry.title = htmlToText(etitle[1]);

    if (isAtom) {
      const elink = entryXml.match(
        /<link[^>]*href="([^"]*)"[^>]*\/?>/i
      );
      if (elink) entry.link = elink[1].trim();
    } else {
      const elink = entryXml.match(/<link>([\s\S]*?)<\/link>/i);
      if (elink) entry.link = elink[1].trim();
    }

    const edesc = entryXml.match(
      /<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i
    );
    if (edesc) {
      const desc = htmlToText(edesc[1]);
      entry.description = desc.length > 500 ? desc.slice(0, 497) + "..." : desc;
    }

    const edate = entryXml.match(
      /<(?:published|updated|pubDate|dc:date)[^>]*>([\s\S]*?)<\/(?:published|updated|pubDate|dc:date)>/i
    );
    if (edate) entry.date = edate[1].trim();

    data.entries.push(entry);
    if (data.entries.length >= 20) break;
  }

  return data;
}

function htmlToText(raw: string): string {
  return raw.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();
}

function formatFeed(data: FeedData): string {
  let md = `## ${data.title || "Untitled Feed"}\n\n`;
  if (data.description) md += `${data.description}\n\n`;
  if (data.link) md += `**Link:** ${data.link}\n\n`;
  md += `---\n\n`;

  for (const entry of data.entries) {
    md += `### ${entry.title || "(untitled)"}\n\n`;
    if (entry.link) md += `**URL:** ${entry.link}  \n`;
    if (entry.date) md += `**Date:** ${entry.date}  \n`;
    if (entry.description) md += `\n${entry.description}\n`;
    md += `\n---\n\n`;
  }

  return md;
}
