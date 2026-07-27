---
name: web-fetch
description: >-
  Fetch and read content from any web URL. Extracts clean Markdown with full
  metadata using Readability.js (Firefox Reader View), Turndown, and Metascraper.
  Use when the user shares a URL, asks to open/read/visit a link, wants to
  inspect a specific page, or needs to drill into search results. Works in ANY
  language (apri, carica, leggi, fetch, open, read, get, öffnen, ouvrir, abrir,
  開く, etc.). Supports HTML, JSON, XML, RSS/Atom feeds. No API keys needed.
---

# Web Fetch v2

This skill uses the `web_fetch` tool to retrieve and parse web page content
via direct HTTP. No external services, API keys, or authentication required.

## When to Use This Skill

**Always use this skill when:**
- The user shares a URL directly
- The user asks to "open", "read", "fetch", "go to", "check out", "load", "visit" a link
- The user asks what's on a specific page
- You need to inspect documentation at a specific URL
- You want to drill into a result found via `web_search`
- You need to read a JSON API response
- The user asks about the content of a specific web page

## How to Fetch

Call the `web_fetch` tool with these parameters:

- **`url`** (required): The full URL including `https://` or `http://`.
- **`raw`** (optional, default `false`): Set to `true` for raw response
  without processing. Use for debugging or when the normal pipeline fails.
- **`noCache`** (optional, default `false`): Bypass the in-session cache
  and force a fresh fetch.

## What It Returns

- **HTML pages**: Main content extracted via Readability.js (Firefox Reader View
  algorithm), converted to clean **Markdown** with preserved structure (headings,
  lists, links, tables, code blocks, bold/italic)
- **JSON APIs**: Auto-detected and pretty-printed
- **RSS/Atom feeds**: Auto-detected and formatted as structured entries
- **Rich metadata**: title, description, author, date, language, publisher,
  OpenGraph image, JSON-LD structured data
- **Extracted links**: Up to 50 links from the page are listed
- Output is smart-truncated at Markdown section boundaries (~8000 tokens target)

## Pipeline

```
URL → robots.txt check → fetch (with retry) → JSDOM parse
    → Readability.js (main content isolation)
    → Metascraper (metadata: OG, Twitter Cards, JSON-LD)
    → Turndown (HTML → Markdown)
    → Smart truncation at section boundaries
    → Output with header metadata + body Markdown + link list
```

## Best Practices

1. **Use after `web_search`** to read specific results in depth
2. **Use `raw: true`** for JSON APIs or when the content pipeline produces
   unexpected results
3. **Check the URL** before fetching — validate it's a real, reachable URL
4. **Handle errors gracefully** — if a fetch fails, try `web_search` to find
   the same info elsewhere
5. The tool respects `robots.txt`, retries on 429/5xx with exponential backoff,
   and caches results within the same session
