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

- **pi-toolkit built-in** (always available) — SearxNG, Tavily, Brave, DuckDuckGo,
  raw scraping. Zero npm deps, auto-detects provider. Automatically yields to
  pi-web-access at runtime if both are installed — no conflicts, no crashes.

---

## ⚠️ CONFIGURATION — READ THIS FIRST

The **unified config file** is:

```
~/.pi/web-search.json
```

This single file configures **both** pi-toolkit and pi-web-access. Write it once.

### Template: SearxNG on a private IP (e.g. 192.168.50.222:8080)

If the user gives you a SearxNG URL on a private/lan IP, write this exact file:

```json
{
  "searchProvider": "searxng",
  "searxngBaseUrl": "http://<IP>:<PORT>",
  "fallbackChain": ["searxng", "duckduckgo", "raw"],
  "providers": {
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  },
  "ssrf": {
    "allowRanges": ["<IP>/24", "<IP>/32"]
  }
}
```

**Replace `<IP>` and `<PORT>`** with the actual values. Include **both** `/24` and `/32` in `allowRanges`.

Example for `192.168.50.222:8080`:

```json
{
  "searchProvider": "searxng",
  "searxngBaseUrl": "http://192.168.50.222:8080",
  "fallbackChain": ["searxng", "duckduckgo", "raw"],
  "providers": {
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  },
  "ssrf": {
    "allowRanges": ["192.168.50.0/24", "192.168.50.222/32"]
  }
}
```

> **Why `ssrf.allowRanges`?** pi-web-access blocks requests to private IPs
> (192.168.x.x, 10.x.x.x, 172.16-31.x.x) as a security measure. Without this,
> searches to a LAN SearxNG will fail with "Blocked internal address".
> Both `/24` (subnet) and `/32` (exact IP) are included for robustness.

### Template: SearxNG on localhost

```json
{
  "searchProvider": "searxng",
  "searxngBaseUrl": "http://localhost:8080",
  "fallbackChain": ["searxng", "duckduckgo", "raw"],
  "providers": {
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  },
  "ssrf": {
    "allowRanges": ["127.0.0.0/8"]
  }
}
```

### Template: SearxNG on a public domain (no SSRF needed)

```json
{
  "searchProvider": "searxng",
  "searxngBaseUrl": "https://search.example.com",
  "fallbackChain": ["searxng", "duckduckgo", "raw"],
  "providers": {
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  }
}
```

### Template: DuckDuckGo only (zero config)

If no SearxNG is available, DuckDuckGo scraping works with zero keys:

```json
{
  "searchProvider": "duckduckgo",
  "fallbackChain": ["duckduckgo", "raw"],
  "providers": {
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  }
}
```

### Template: Tavily or Brave (API keys)

```json
{
  "searchProvider": "tavily",
  "fallbackChain": ["tavily", "duckduckgo", "raw"],
  "providers": {
    "tavily": { "apiKey": "$TAVILY_API_KEY" },
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  }
}
```

The `$VAR` syntax resolves environment variables at runtime.

---

## Available Providers

| Provider | Type | API Key? | Best for |
|----------|------|----------|----------|
| **SearxNG** | Self-hosted API | ❌ | Privacy, multi-engine aggregation, infoboxes/answers |
| **Tavily** | SaaS API | ✅ (`TAVILY_API_KEY`) | AI-optimized results, LLM-generated answers |
| **Brave** | SaaS API | ✅ (`BRAVE_API_KEY`) | 2000 req/month free tier, web+news+video |
| **DuckDuckGo** | HTML scraping | ❌ | Zero-config, always available, no keys |
| **Raw** | DDG Lite scraping | ❌ | Absolute fallback, ultra-light HTML |

> **pi-web-access** adds: OpenAI, Parallel, TinyFish, Search1API, Searchinfinity,
> Querit, SERPdive, Exa, Perplexity, Gemini, AnySearch. See its own docs for
> provider-specific API key setup.

---

## Field reference for `~/.pi/web-search.json`

| Field | Used by | Description |
|-------|---------|-------------|
| `searchProvider` | both | Default provider name: `searxng`, `tavily`, `brave`, `duckduckgo`, `raw` |
| `searxngBaseUrl` | both | SearxNG endpoint URL. Root-level, not nested in `providers` |
| `fallbackChain` | pi-toolkit | Ordered list of providers to try if the primary fails |
| `providers.<name>` | pi-toolkit | Per-provider config: `baseUrl` (legacy), `apiKey`, `enabled` |
| `ssrf.allowRanges` | pi-web-access | CIDR ranges exempt from SSRF blocking (needed for LAN IPs) |

> **Legacy note:** pi-toolkit v3.0 used `~/.pi/agent/web-search/config.json`
> with `provider` (now `searchProvider`) and `providers.searxng.baseUrl` (now
> root-level `searxngBaseUrl`). If you find a legacy config, migrate it to the
> unified format above — or pi-toolkit v3.1+ will auto-migrate on first load.

---

## Setup procedure (for AI agents)

When a user asks you to set up web search with a SearxNG endpoint:

1. **Determine the IP**: if it's a private IP (starts with `192.168.`, `10.`, `172.16.` through `172.31.`, or `127.`), you MUST include `ssrf.allowRanges`
2. **Write `~/.pi/web-search.json`** using the exact template above — replace `<IP>` and `<PORT>`
3. **For private IPs**: derive the `/24` subnet (replace last octet with `0`) and add both `/24` and `/32` ranges
4. **Test** with a simple search query to confirm it works
5. **If it fails** with "Blocked internal address": the `ssrf.allowRanges` is missing or wrong — fix and retry

---

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

> **pi-web-aware note:** pi-web-access supports additional parameters:
> `queries` (array of strings for multi-angle research), `numResults`,
> `includeContent`, `recencyFilter`, `domainFilter`, `provider`, `workflow`.
> Check its tool description for details. Prefer `queries` with 2-4 varied
> angles over a single `query` for broader coverage.

## Fallback Chain

If the primary provider fails (timeout, rate limit, error), the next provider
in the chain is tried automatically. Default chain:

```
searxng → duckduckgo → raw
```

## Search Strategies

- **Start broad**, then narrow down with specific queries
- **Use `language`** when the user needs results in a specific language
- **Use `time_range`** for news: `"day"` for today, `"week"` for recent
- **Use `categories: "news"`** to get fresh results from news outlets
- **Use `page`** for pagination when you need more results
- **After getting results, synthesize** — don't just paste snippets
- **If the current provider is slow**, the fallback chain kicks in automatically
