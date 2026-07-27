# pi-toolkit

Skills, extensions, and tools for the [pi coding agent](https://github.com/earendil-works/pi).

## What's inside

### Extensions (tools callable by the LLM)

| Tool | What it does | Needs API key? |
|------|-------------|----------------|
| **`web_search`** | Multi-provider web search: SearxNG, Tavily, Brave, DuckDuckGo, raw scraping. Auto-detects the best available provider on startup. | Optional — DuckDuckGo and raw scraping work out of the box with zero keys. |
| **`web_fetch`** | Fetches any URL and returns clean Markdown with metadata. Uses Mozilla Readability (Firefox Reader View), Turndown, and Metascraper for OpenGraph/Twitter Cards/JSON-LD. Handles HTML, JSON, XML, RSS/Atom. | No — pure HTTP, zero external services. |
| **`subagent-setup`** | Interactive wizard that detects missing subagent models and helps you reconfigure them via pi's UI — no manual JSON editing. | No |

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
pi install npm:pi-subagents   # subagent delegation + contact_supervisor
pi install npm:pi-intercom    # cross-session messaging (optional)
```

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

### 4. Configure web search provider

**Zero-config:** DuckDuckGo scraping works immediately — no setup needed.

**For better results,** Web Search auto-detects on startup:

1. Checks the `SEARXNG_URL` environment variable
2. Probes `localhost:8080`, `localhost:8888`, and `127.0.0.1:8080` for a SearxNG instance
3. Checks for `TAVILY_API_KEY` or `BRAVE_API_KEY` environment variables
4. Falls back to DuckDuckGo scraping if nothing else is available

If you want to change the provider later, edit `~/.pi/agent/web-search/config.json`:

```json
{
  "provider": "searxng",
  "fallbackChain": ["searxng", "duckduckgo", "raw"],
  "providers": {
    "searxng": { "baseUrl": "http://your-server:8080" },
    "tavily": { "apiKey": "$TAVILY_API_KEY" },
    "brave": { "apiKey": "$BRAVE_API_KEY" },
    "duckduckgo": { "enabled": true },
    "raw": { "enabled": true }
  }
}
```

The `$VAR` syntax resolves environment variables at runtime.

### 5. Reload pi

```
/reload
```

## Fallback chain (web search)

If the primary search provider fails, the next one in the chain is tried automatically:

```
searxng → duckduckgo → raw
```

DuckDuckGo and raw scraping are always available — they use public HTML endpoints with zero API keys.

## Subagent delegation

Available agents after installing `pi-subagents`:

| Agent | Tier | Purpose |
|-------|------|---------|
| `scout` | light | Fast local codebase recon → compressed findings |
| `researcher` | light | Web/docs research with cited sources |
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
| `web_search` | ✅ | Auto-detects provider. DuckDuckGo + raw work anywhere. |
| `web_fetch` | ✅ | Pure JS, no external services. |
| `subagent-setup` | ✅ | Interactive wizard adapts models to any environment. |
| `loop` skill | ✅ | Bash required (pi requires it on all OS). |
| Skills (.md files) | ✅ | Plain text, no OS dependencies. |
| Subagent models config | ⚠️ per-environment | Configured via interactive wizard on first run. |
| SearxNG endpoint | ⚠️ per-environment | Auto-detected or set via `SEARXNG_URL` env var. |

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi) (any supported OS)
- [pi-subagents](https://github.com/nicobailon/pi-subagents) (`pi install npm:pi-subagents`)
- [pi-intercom](https://github.com/nicobailon/pi-intercom) (optional, `pi install npm:pi-intercom`)
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

### Same-purpose tools with different names

No technical conflict — both appear in "Available tools". However, two similar tools can:
- **Waste tokens** — two descriptions in the system prompt instead of one
- **Cause suboptimal picks** — the LLM chooses the less capable tool if its description is clearer

If you already have a search/fetch tool, decide which one to keep and disable the other:

```bash
# Disable a specific extension
mv ~/.pi/agent/extensions/old-search.ts ~/.pi/agent/extensions/old-search.ts.disabled

# Or disable via settings (if the extension supports it)
# See the extension's docs for tool enable/disable flags
```

Then `/reload`.

## License

MIT
