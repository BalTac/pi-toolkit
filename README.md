# pi-toolkit

Skills, extensions, and tools for the [pi coding agent](https://github.com/earendil-works/pi).

## What's inside

### Extensions (tools callable by the LLM)

| Tool | What it does | Needs API key? |
|------|-------------|----------------|
| **`subagent-setup`** | Interactive wizard that detects missing subagent models and helps you reconfigure them via pi's UI — no manual JSON editing. | No |
| **`deepseek-balance`** | Shows DeepSeek credit balance and session cost in pi's status bar. Auto-activates when the current provider is DeepSeek. | Optional — reads key from `~/.pi/agent/auth.json` or `DEEPSEEK_API_KEY` env var |
| **`web_search` / `fetch_content` / `source_check` / `get_search_content`** | Web search, content fetching, claim verification, and content retrieval — provided by the **bundled** [pi-web-access](https://github.com/nicobailon/pi-web-access) (18+ search providers, GitHub cloning, YouTube transcripts, PDF extraction, video analysis). | Zero-config (Exa MCP) or add API keys in `~/.pi/web-search.json` |

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

**pi-web-access is bundled** — no separate install needed; pi installs it automatically with the toolkit.

### 2. Install pi-subagents (required) and pi-intercom (recommended)

```bash
pi install npm:pi-subagents                    # subagent delegation + contact_supervisor
pi install npm:pi-intercom                     # cross-session messaging (optional, recommended)
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

## Web access (via bundled pi-web-access)

This toolkit **no longer ships its own `web_search` / `web_fetch`** — they were redundant and conflicted with [pi-web-access](https://github.com/nicobailon/pi-web-access), which is now a **bundled dependency** of pi-toolkit.

Web tools registered by the bundled extension:

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
| `researcher` | light | Web/docs research with cited sources (custom — uses bundled pi-web-access) |
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
| `web_search` / `fetch_content` (pi-web-access, bundled) | ⚠️ | Requires npm deps — auto-installed by pi on install/reconcile. |
| `subagent-setup` | ✅ | Interactive wizard adapts models to any environment. |
| `deepseek-balance` | ✅ | Reads key from auth.json or env var. |
| `loop` skill | ✅ | Bash required (pi requires it on all OS). |
| Skills (.md files) | ✅ | Plain text, no OS dependencies. |
| Subagent models config | ⚠️ per-environment | Configured via interactive wizard on first run. |

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi) (v0.37.3+)
- [pi-subagents](https://github.com/nicobailon/pi-subagents) (`pi install npm:pi-subagents`)
- [pi-intercom](https://github.com/nicobailon/pi-intercom) (optional, recommended, `pi install npm:pi-intercom`)
- **pi-web-access** — bundled inside pi-toolkit as a dependency. No separate install needed; npm deps are auto-installed by pi on install/reconcile.

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

pi-toolkit bundles pi-web-access, which registers `web_search`, `fetch_content`, `source_check`, and `get_search_content`. Do **not** install pi-web-access separately — doing so would register the same tools twice and pi would fail on startup.

A startup guard (in `subagent-setup`) warns if a separate pi-web-access installation is detected in `~/.pi/agent/settings.json`. Remove it with:

```bash
pi remove npm:pi-web-access
# or
pi remove git:github.com/nicobailon/pi-web-access
```

## License

MIT
