# pi-toolkit

Skills, extensions, and tools for the [pi coding agent](https://github.com/earendil-works/pi).

> **pi-toolkit ships no third-party pi packages.** Required and recommended
> companion packages are installed separately. After you install (or update)
> pi-toolkit, a **post-install notification** tells you which companions are
> missing and how to install them: turn to `/pi-toolkit-deps` (a command) or
> `pi_toolkit_install_guide` (a tool). See [Quick install](#quick-install).

## What's inside

### Extensions (tools callable by the LLM)

| Tool | What it does | Needs API key? |
|------|-------------|----------------|
| **`install-guide`** | On session_start, checks the required/recommended companion packages and toasts any missing ones. Registers `/pi-toolkit-deps` and the `pi_toolkit_install_guide` tool so the LLM sees the install commands. | No |
| **`subagent-setup`** | Interactive wizard that detects missing subagent models and helps you reconfigure them via pi's UI — no manual JSON editing. | No |
| **`deepseek-balance`** | Shows DeepSeek credit balance and session cost in pi's status bar, with model in/out rates per 1M and a live peak/off-peak badge for DeepSeek V4 (peak 01:00–04:00 & 06:00–10:00 UTC, off-peak = half price). Auto-activates when the current provider is DeepSeek. | Optional — reads key from `~/.pi/agent/auth.json` or `DEEPSEEK_API_KEY` env var |
| **`model-prices`** | `/pricing` (aliases `/prices`, `/model-prices`): full-screen price comparison of every available model (input/output/cache per 1M tokens from the model registry) with sort by price, peak/off-peak badge for DeepSeek V4, and instant model switch. `/pricing-report [path]` (aliases `/price-report`, `/pricing-html`): generates a self-contained HTML report with charts by type/category/provider/price bracket, filters, live peak/off-peak badge and a multi-select comparison picker, then opens it in the browser. | No |
| **`web_search` / `fetch_content` / `source_check` / `get_search_content`** | Web search, content fetching, claim verification, and content retrieval — provided by [pi-web-access](https://github.com/nicobailon/pi-web-access) (a **required** companion; 18+ search providers, GitHub cloning, YouTube transcripts, PDF extraction, video analysis). | Zero-config (Exa MCP) or add keys in `~/.pi/web-search.json` |

### Skills (on-demand guidance for the LLM)

| Skill | What it does |
|-------|-------------|
| **`subagent`** | Subagent delegation guide: available agents (scout, planner, worker, reviewer, researcher, oracle, analyst, delegate), modes (single/parallel/chain), supervisor escalation via `contact_supervisor`. |
| **`loop`** | Autonomous engineering loop: interview → criteria → inspect/plan/implement/validate/decide cycle with git checkpoints, anti-tampering, subagent delegation, and session resume. |

### Agents

| Agent | Role | Tier |
|-------|------|------|
| **`researcher`** | Autonomous web researcher using pi-web-access tools (`web_search`, `fetch_content`, `source_check`). | light |
| **`analyst`** | Read-only code/data analyst. Inspects files, runs safe commands, produces measurements — zero side effects. | light |

## Quick install

### 1. Install this toolkit

```bash
pi install git:github.com/BalTac/pi-toolkit
```

pi-toolkit bundles **nothing** — it only adds its own extensions, skills, and
agents. It does **not** pull in companion packages automatically.

### 2. Install required & recommended companions

Run each `pi install` below. If you miss any, pi-toolkit will tell you: a
post-install toast appears on startup, `/pi-toolkit-deps` re-lists them, and
the `pi_toolkit_install_guide` tool gives the LLM the same list.

```bash
pi install npm:pi-web-access                 # REQUIRED — web search / content fetching
pi install npm:pi-subagents                  # REQUIRED — subagent delegation + contact_supervisor
pi install npm:pi-intercom                   # recommended — cross-session messaging
pi install npm:@narumitw/pi-usage             # recommended — provider usage / credit dashboard (/usage)
pi install npm:pi-agent-budget               # recommended — cost / budget tracking (/budget)
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

### 4. Reload pi

```
/reload
```

---

## Upgrading pi-toolkit

Just update the toolkit; there are no bundled packages to remove or reconcile:

```bash
pi update --extensions
```

Because pi-toolkit bundles nothing, updating it never leaves stale bundled
packages behind. If a previous version of pi-toolkit bundled pi-web-access,
updating to this version **prunes it automatically** from pi-toolkit's own
`node_modules` (pi re-runs `npm install` on reconcile) — the toolkit simply
stops shipping it. If you rely on `web_search`/`fetch`, make sure the
`pi-web-access` **required companion** is installed separately (see
[Quick install](#quick-install)).

> **Legacy config migration:** if you previously used pi-toolkit's built-in
> web search, your old config may still live at
> `~/.pi/agent/web-search/config.json`. pi-web-access reads
> `~/.pi/web-search.json`. On the first startup after updating, pi-toolkit
> migrates the legacy file automatically (provider → `searchProvider`,
> `providers.searxng.baseUrl` → `searxngBaseUrl`) and notifies you.

---

## Web access (pi-web-access — required companion)

`web_search` / `fetch_content` / `source_check` / `get_search_content` come
from [pi-web-access](https://github.com/nicobailon/pi-web-access), installed
separately as a **required companion**:

```bash
pi install npm:pi-web-access
```

Web tools registered by pi-web-access:

| Tool | What it does |
|------|-------------|
| `web_search` | Search via OpenAI/Codex, Exa (zero-config), Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, SERPdive, Kagi, Ollama, xAI, Bright Data, SerpBase, SearXNG, Perplexity, Gemini. Synthesized answers with citations, curator UI (`/websearch`), batch queries. |
| `fetch_content` | Fetch URLs as readable markdown or raw text, clone GitHub repos, YouTube transcripts + frame extraction, PDF → Markdown, local video analysis, images. |
| `source_check` | Verify a claim against sources with exact passage citations. |
| `get_search_content` | Retrieve stored content from previous searches/fetches. |

**Zero config:** works out of the box via Exa MCP — no API keys needed. For more providers, add keys to `~/.pi/web-search.json` (see the [pi-web-access docs](https://github.com/nicobailon/pi-web-access)).

## Subagent delegation

Available agents after installing `pi-subagents` (plus the custom `researcher` and `analyst` from this toolkit):

| Agent | Tier | Purpose |
|-------|------|---------|
| `scout` | light | Fast local codebase recon → compressed findings |
| `researcher` | light | Web/docs research with cited sources (custom — uses pi-web-access) |
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
| `web_search` / `fetch_content` (pi-web-access, required companion) | ⚠️ | Requires npm deps — auto-installed by pi when you `pi install npm:pi-web-access`. |
| `install-guide` / `subagent-setup` | ✅ | Instant notifications + interactive wizard. |
| `deepseek-balance` | ✅ | Reads key from auth.json or env var. |
| `loop` skill | ✅ | Bash required (pi requires it on all OS). |
| Skills (.md files) | ✅ | Plain text, no OS dependencies. |
| Subagent models config | ⚠️ per-environment | Configured via interactive wizard on first run. |

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi) (v0.37.3+)
- **Required** companions:
  - [pi-web-access](https://github.com/nicobailon/pi-web-access) (`pi install npm:pi-web-access`) — web search / content fetching
  - [pi-subagents](https://github.com/nicobailon/pi-subagents) (`pi install npm:pi-subagents`) — subagent delegation
- **Recommended** companions:
  - [pi-intercom](https://github.com/nicobailon/pi-intercom) (`pi install npm:pi-intercom`) — cross-session messaging
  - [pi-usage](https://github.com/narumiruna/pi-extensions) (`pi install npm:@narumitw/pi-usage`) — provider usage/credit dashboard
  - [pi-agent-budget](https://github.com/nicobailon/pi-agent-budget) (`pi install npm:pi-agent-budget`) — cost/budget tracking

## Conflict handling

### Same-name skills

pi loads skills in this order: **global** (`~/.pi/agent/skills/`) → **packages** (npm/git installs) → **project** (`.pi/skills/`). The **first** one found wins. Later definitions with the same name show a warning and are ignored.

If you already have a global `subagent` or `loop` skill, it will shadow the one from this toolkit. To fix:

```bash
# Option A: remove the old one
rm -rf ~/.pi/agent/skills/subagent

# Option B: rename the old one
mv ~/.pi/agent/skills/subagent ~/.pi/agent/skills/subagent-old
```

Then `/reload`.

### Same-name tools (`web_search`)

`web_search`, `fetch_content`, `source_check`, and `get_search_content` come
from the **pi-web-access** companion. Install it **once** (`pi install
npm:pi-web-access`). Do not install it a second way — e.g. both top-level and
bundled inside an older pi-toolkit — or the tools would be registered twice.

## License

MIT
