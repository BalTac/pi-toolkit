---
name: web-search
description: >-
  Web search via multiple configurable providers (SearxNG, Tavily, Brave,
  DuckDuckGo, or raw scraping). Use this whenever the user asks to search, look
  up, find, or research something online — in ANY language. Also use when the
  user needs current information, recent news, documentation lookups, error
  message investigation, or any facts beyond your training cutoff. Works across
  all search categories and supports language/time filtering, safe search, and
  pagination. DuckDuckGo and raw scraping need zero API keys — works out of the
  box in any environment.
---

# Web Search (Multi-Provider)

This skill teaches you how to use the `web_search` tool. Depending on your
environment, `web_search` is provided by one of these extensions:

- **[pi-web-access](https://github.com/nicobailon/pi-web-access)** (recommended) —
  OpenAI, Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily,
  SERPdive, SearXNG, Exa, Perplexity, Gemini, AnySearch. Supports multi-query,
  interactive browser curation, AI auto-summary, source checking, and content
  fetching. Install with: `pi install git:github.com/nicobailon/pi-web-access`

- **pi-toolkit built-in** (fallback) — SearxNG, Tavily, Brave, DuckDuckGo,
  raw scraping. Zero npm deps, auto-detects provider. Disabled by default when
  pi-web-access is installed to avoid tool-name conflicts.

Both extensions share `~/.pi/agent/web-search/config.json`.
No API keys required for DuckDuckGo scraping — works immediately.

## Available Providers

| Provider | Type | API Key? | Best for |
|----------|------|----------|----------|
| **SearxNG** | Self-hosted API | ❌ | Privacy, multi-engine aggregation, infoboxes/answers |
| **Tavily** | SaaS API | ✅ (`$TAVILY_API_KEY`) | AI-optimized results, LLM-generated answers |
| **Brave** | SaaS API | ✅ (`$BRAVE_API_KEY`) | 2000 req/month free tier, web+news+video |
| **DuckDuckGo** | HTML scraping | ❌ | Zero-config, always available, no keys |
| **Raw** | DDG Lite scraping | ❌ | Absolute fallback, ultra-light HTML |

Config file: `~/.pi/agent/web-search/config.json`
(created automatically on first run — no setup needed for DuckDuckGo)

## How to Search

Call the `web_search` tool with these parameters:

- **`query`** (required): Concise, keyword-focused search.
- **`limit`** (optional, default 8): Number of results (1–15).
- **`categories`** (optional, default `"general"`): `general`, `news`, `images`,
  `videos`, `music`, `it`, `science`, `files`, `social media`, `map`.
- **`engines`** (optional): Comma-separated engine names. Only supported by SearxNG.
- **`language`** (optional, default `"all"`): `"en"`, `"it"`, `"fr"`, `"all"`, etc.
- **`time_range`** (optional): `"day"`, `"week"`, `"month"`, `"year"`.
- **`safesearch`** (optional): 0 (off), 1 (moderate), 2 (strict).
- **`page`** (optional, default 1): Pagination (1-based).
- **`noCache`** (optional, default false): Force a fresh search.

## Fallback Chain

If the primary provider fails (timeout, rate limit, error), the next provider
in the chain is tried automatically. Default chain:

```
searxng → duckduckgo → raw
```

You can customize this in `config.json`. Example:

```json
{
  "provider": "tavily",
  "fallbackChain": ["tavily", "brave", "duckduckgo", "raw"],
  "providers": {
    "tavily": { "apiKey": "$TAVILY_API_KEY" },
    "brave": { "apiKey": "$BRAVE_API_KEY" },
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  }
}
```

## Provider-specific notes

- **SearxNG**: Set `SEARXNG_URL` env var or configure `baseUrl` in providers.searxng.
  Supports `categories`, `engines`, `language`, `time_range`, `safesearch`, `page`.
  Returns `answers`, `infoboxes`, `corrections`, and `suggestions`.

- **Tavily**: Set `TAVILY_API_KEY` env var. Supports `topic: "news"` → set categories to
  `"news"`. Returns LLM-generated `answer` in addition to results. `search_depth`
  defaults to `basic` (1 credit per search).

- **Brave**: Set `BRAVE_API_KEY` env var. Supports web search and news search
  (use `categories: "news"` for news endpoint). 2000 free requests/month.

- **DuckDuckGo**: Zero config. Uses DDG's non-JS HTML endpoint. Results include
  title, URL (decoded from DDG redirect), and snippet. No answers/infoboxes.

- **Raw**: Absolute fallback. Uses DDG Lite (ultra-light HTML, no JavaScript
  at all). Maximally portable — works on any OS with Node.js. No answers/infoboxes.

## Search Strategies

- **Start broad**, then narrow down with specific queries
- **Use `language`** when the user needs results in a specific language
- **Use `time_range`** for news: `"day"` for today, `"week"` for recent
- **Use `categories: "news"`** to get fresh results from news outlets
- **Use `page`** for pagination when you need more results
- **After getting results, synthesize** — don't just paste snippets
- **If the current provider is slow**, the fallback chain kicks in automatically
