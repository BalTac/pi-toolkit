# pi-toolkit

Skills, extensions, and tools for the [pi coding agent](https://github.com/earendil-works/pi).

## What's inside

### Extensions (tools callable by the LLM)

| Tool | What it does | Needs API key? |
|------|-------------|----------------|
| **`web_fetch`** | Fetches any URL and returns clean Markdown with metadata. Uses Mozilla Readability (Firefox Reader View), Turndown, and Metascraper for OpenGraph/Twitter Cards/JSON-LD. Handles HTML, JSON, XML, RSS/Atom. | No — pure HTTP, zero external services. |
| **`subagent-setup`** | Interactive wizard that detects missing subagent models and helps you reconfigure them via pi's UI — no manual JSON editing. | No |
| **`web_search`** | Multi-provider web search: SearxNG, Tavily, Brave, DuckDuckGo, raw scraping. Auto-detects the best available provider on startup. Automatically yields to pi-web-access if both are installed — no conflicts, no crashes. | Optional — DuckDuckGo and raw scraping work out of the box with zero keys. |

### Skills (on-demand guidance for the LLM)

| Skill | What it does |
|-------|-------------|
| **`web-search`** | Teaches the agent when and how to use `web_search`: search strategies, categories, language filtering, fallback chain. |
| **`web-fetch`** | Teaches the agent when to read URLs, how to use raw vs processed mode, and when to drill into search results. |
| **`subagent`** | Subagent delegation guide: available agents (scout, planner, worker, reviewer, researcher, oracle, analyst, delegate), modes (single/parallel/chain), supervisor escalation via `contact_supervisor`. |
| **`loop`** | Autonomous engineering loop: interview → criteria → inspect/plan/implement/validate/decide cycle with git checkpoints, anti-tampering, subagent delegation, and session resume. |

### Agents

| Agent | Role | Tier |
|-------|------|------|
| **`analyst`** | Read-only code/data analyst. Inspects files, runs safe commands, produces measurements — zero side effects. | light |

## Quick install

### 1. Install this toolkit

```bash
pi install git:github.com/BalTac/pi-toolkit
```

### 2. Install community dependencies

```bash
pi install npm:pi-subagents                    # subagent delegation + contact_supervisor
pi install npm:pi-intercom                     # cross-session messaging (optional, recommended)
pi install git:github.com/nicobailon/pi-web-access  # web search + content fetching (recommended)
```

> **Why `pi-web-access`?** This toolkit's built-in `web_search` is deliberately **disabled by default** to avoid tool-name conflicts. Instead, we recommend [`pi-web-access`](https://github.com/nicobailon/pi-web-access) by Nico Bailon — a vastly more capable web search extension. See [Web Search Options](#web-search-options) for the full rationale.

### 3. Configure models for subagents

On first `/reload`, the **subagent-setup wizard** will detect that your configured models don't match this environment and offer to reconfigure them via an interactive selector. Pick one **light** model (fast/cheap — for scout, researcher, analyst, delegate) and one **powerful** model (full capability — for planner, worker, reviewer, oracle).

If you skip the wizard, subagents simply inherit your current session model (safe fallback).

Model config lives in `~/.pi/agent/settings.json` under `subagents`:

```json
{
  "subagents": {
    "defaultModel": "deepseek-v4-flash",
    "agentOverrides": {
      "planner": { "model": "deepseek-v4-pro" },
      "worker": { "model": "deepseek-v4-pro" },
      "reviewer": { "model": "deepseek-v4-pro" },
      "oracle": { "model": "deepseek-v4-pro" },
      "context-builder": { "model": "deepseek-v4-pro" }
    }
  }
}
```

### 4. Reload pi

```
/reload
```

---

## Web Search Options

This toolkit includes a `web_search` extension that **auto-detects conflicts** with `pi-web-access` at runtime. If `pi-web-access` is installed, pi-toolkit's `web_search` silently steps aside — no crash, no config changes needed. If `pi-web-access` is not installed, the built-in search works normally.

### Recommended: `pi-web-access` (Nico Bailon)

```
pi install git:github.com/nicobailon/pi-web-access
```

| Feature | pi-toolkit built-in | pi-web-access |
|---------|---------------------|---------------|
| **Providers** | SearxNG, Tavily, Brave, DuckDuckGo, Raw | OpenAI, Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, SERPdive, SearXNG, Exa, Perplexity, Gemini, AnySearch |
| **Multi-query** | ❌ Single query | ✅ Up to 8 queries with varied angles per search |
| **Interactive curator** | ❌ | ✅ Browser UI for reviewing/approving/culling results |
| **Auto-summary** | ❌ | ✅ AI-generated synthesis with model choice |
| **Source check** | ❌ | ✅ Verify claims against sources with passage citations |
| **Content fetching** | ❌ | ✅ `fetch_content` + `get_search_content` for full page extraction |
| **YouTube / video** | ❌ | ✅ Transcripts, frame extraction, AI video understanding |
| **GitHub repos** | ❌ | ✅ Clone + read repository contents |
| **PDF extraction** | ❌ | ✅ Extract text from PDF URLs |
| **Dependencies** | Zero | ~6 npm packages (auto-installed) |

**Why this design?** Both extensions register a tool named `web_search`. Pi cannot load two tools with the same name — the second one would crash. Instead of forcing you to choose at install time, pi-toolkit detects the conflict at runtime and silently yields.

**Upgrade safety:** if you update from an older pi-toolkit (v3.0) on a machine where only pi-toolkit is installed, `web_search` continues to work as before. If pi-web-access was also installed, the conflict is now resolved automatically instead of crashing pi on startup.

### How the agent handles this at install time

When an AI agent is instructed to set up pi with this toolkit:

1. Install `pi-web-access` **alongside** pi-toolkit (step 2 of Quick install)
2. No manual config changes needed — pi-toolkit detects pi-web-access at runtime and yields
3. Both extensions share `~/.pi/web-search.json` — see the [web-search skill](skills/web-search/SKILL.md) for the exact JSON template
4. The `web-search` **skill** works regardless of which extension provides the tool

---

## Web Search Configuration (built-in, when enabled)

**Zero-config:** DuckDuckGo scraping works immediately — no setup needed.

**For better results,** the built-in web search auto-detects on startup:

1. Checks the `SEARXNG_URL` environment variable
2. Probes `localhost:8080`, `localhost:8888`, and `127.0.0.1:8080` for a SearxNG instance
3. Checks for `TAVILY_API_KEY` or `BRAVE_API_KEY` environment variables
4. Falls back to DuckDuckGo scraping if nothing else is available

If you want to change the provider later, edit `~/.pi/web-search.json`:

```json
{
  "searchProvider": "searxng",
  "searxngBaseUrl": "http://your-server:8080",
  "fallbackChain": ["searxng", "duckduckgo", "raw"],
  "providers": {
    "tavily": { "apiKey": "$TAVILY_API_KEY" },
    "brave": { "apiKey": "$BRAVE_API_KEY" },
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  }
}
```

The `$VAR` syntax resolves environment variables at runtime.

> **Migration:** if you had the old `~/.pi/agent/web-search/config.json`, it is automatically migrated to `~/.pi/web-search.json` on first load. The legacy `providers.searxng.baseUrl` field becomes the root-level `searxngBaseUrl`.

> **Note:** `pi-web-access` uses the same unified config file (`~/.pi/web-search.json`). pi-toolkit's built-in `web_search` also reads/writes this file (with automatic migration from the old `~/.pi/agent/web-search/config.json`). Both extensions coexist peacefully on the same config — just never enable both `web_search` tools at once.

## Fallback chain (built-in search)

If the primary search provider fails, the next one in the chain is tried automatically:

```
searxng → duckduckgo → raw
```

DuckDuckGo and raw scraping are always available — they use public HTML endpoints with zero API keys.

## Subagent delegation

Available agents after installing `pi-subagents` (plus the custom `researcher` and `analyst` from this toolkit):

| Agent | Tier | Purpose |
|-------|------|---------|
| `scout` | light | Fast local codebase recon → compressed findings |
| `researcher` | light | Web/docs research with cited sources (custom — uses web_search + web_fetch) |
| `analyst` | light | Read-only measurements and reports (custom) |
| `delegate` | light | General-purpose child close to parent behavior |
| `planner` | powerful | Concrete implementation plans (read-only) |
| `worker` | powerful | Implementation work, edits files, validates |
| `reviewer` | powerful | Code review: quality, security, edge cases |
| `oracle` | powerful | Second opinion: challenges assumptions before acting |
| `context-builder` | powerful | Context-gathering pass → handoff material |

**Supervisor coordination:** child agents can contact the parent session via
`contact_supervisor` with three reasons: `need_decision` (blocking ask),
`interview_request` (structured questions), or `progress_update` (non-blocking).
Parent replies with `subagent_supervisor({ action: "reply", ... })`.

## Autonomous loop (`/skill:loop`)

The loop skill implements a structured engineering cycle:

```
Interview (5 questions, "R" shortcut for all recommended)
    ↓
Define success criteria + validation script
    ↓
Cycle: INSPECT → IDENTIFY → PLAN → IMPLEMENT → VALIDATE → CHECKPOINT → DECIDE
    ↓
Stop: all criteria pass | max iterations | time budget | idle | blocked
    ↓
Final Report
```

Key features: git checkpoints with auto-revert on regression, atomic state writes,
anti-tampering on success criteria, session resume across restarts, optional
subagent delegation at each step.

## Environment portability

| What | Portable? | Notes |
|------|-----------|-------|
| `web_search` (built-in) | ✅ | Auto-detects provider. DuckDuckGo + raw work anywhere. |
| `web_search` (pi-web-access) | ⚠️ | Requires npm deps. More providers but needs install. |
| `web_fetch` | ✅ | Pure JS, no external services. |
| `subagent-setup` | ✅ | Interactive wizard adapts models to any environment. |
| `loop` skill | ✅ | Bash required (pi requires it on all OS). |
| Skills (.md files) | ✅ | Plain text, no OS dependencies. |
| Subagent models config | ⚠️ per-environment | Configured via interactive wizard on first run. |
| SearxNG endpoint | ⚠️ per-environment | Auto-detected or set via `SEARXNG_URL` env var. |

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi) (any supported OS)
- [pi-subagents](https://github.com/nicobailon/pi-subagents) (`pi install npm:pi-subagents`)
- [pi-intercom](https://github.com/nicobailon/pi-intercom) (optional, recommended, `pi install npm:pi-intercom`)
- [pi-web-access](https://github.com/nicobailon/pi-web-access) (recommended for web search, `pi install git:github.com/nicobailon/pi-web-access`)
- `web_fetch` npm deps (jsdom, @mozilla/readability, turndown, metascraper — auto-installed by `pi install`)

## Conflict handling

### Same-name skills

pi loads skills in this order: **global** (`~/.pi/agent/skills/`) → **packages** (npm/git installs) → **project** (`.pi/skills/`). The **first** one found wins. Later definitions with the same name show a warning and are ignored.

If you already have a global `web-search` or `web-fetch` skill, it will shadow the one from this toolkit. To fix:

```bash
# Option A: remove the old one
rm -rf ~/.pi/agent/skills/web-search

# Option B: rename the old one
mv ~/.pi/agent/skills/web-search ~/.pi/agent/skills/web-search-old
```

Then `/reload`.

### Same-name tools (`web_search`)

Only **one** extension can register a tool with a given name. If two extensions register the same tool name, pi would normally crash on startup.

This toolkit's `web_search` extension **detects conflicts at runtime** and silently yields if another extension (like `pi-web-access`) already registered `web_search`. A diagnostic message is logged to the console so you know what happened:

```
[pi-toolkit] web_search NOT registered: another extension already owns this tool.
  This is expected if pi-web-access is installed — it provides a more capable web_search.
  To use pi-toolkit's web_search instead, uninstall pi-web-access:
    pi uninstall git:github.com/nicobailon/pi-web-access
  Then reload pi.
```

**No action needed.** Everything works whether you have pi-web-access or not.

## License

MIT
