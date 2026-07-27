---
name: subagent
description: >-
  Delegate tasks to specialized sub-agents with isolated context windows. Use
  when the user asks to "delegate", "spawn an agent", "use a subagent", "run in
  parallel", "run in background", "have an agent do X", "ask scout/planner/worker/
  reviewer/researcher/oracle/analyst to..." — or when a task would benefit from
  isolated context, a specialized role, parallel execution, or a second opinion.
  Works in ANY language (delega, usa un subagente, lancia un agente, déléguer,
  delegar, 委託, etc.).
---

# Sub-agent Delegation (pi-subagents)

Delegation is provided by the **pi-subagents** extension. Sub-agents run as
child pi sessions with isolated context. The parent delegates via the
`subagent` tool; children can report back via `contact_supervisor`.

## Available Agents

| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| `scout` | light | deepseek-v4-flash | Fast local codebase recon → compressed findings |
| `researcher` | light | deepseek-v4-flash | Web/docs research with sources |
| `analyst` | light | deepseek-v4-flash | Read-only measurements, stats, reports (custom agent) |
| `planner` | powerful | deepseek-v4-pro | Concrete implementation plans (read-only) |
| `worker` | powerful | deepseek-v4-pro | Implementation work, edits files, validates |
| `reviewer` | powerful | deepseek-v4-pro | Code review vs task/plan, edge cases, simplicity |
| `oracle` | powerful | deepseek-v4-pro | Second opinion: challenges assumptions before acting |
| `context-builder` | powerful | deepseek-v4-pro | Strong context-gathering pass → handoff material |
| `delegate` | light | deepseek-v4-flash | General-purpose child close to parent behavior |

Model config lives in `~/.pi/agent/settings.json` under `subagents`
(`defaultModel` = light tier, `agentOverrides` = powerful roles).
Rule of thumb: `scout` before you understand code, `researcher` before you
trust external facts, `planner` before a bigger change, `worker` to implement,
`reviewer` to check, `oracle` when the decision itself feels risky.

### Portable Model Setup

In a new environment, edit `~/.pi/agent/settings.json` to match your available
models. Use `/subagents-models` to inspect the live mapping. Example for
OpenAI-only environments:

```json
"subagents": {
  "defaultModel": "gpt-5-mini",
  "agentOverrides": {
    "planner": { "model": "gpt-5.4" },
    "worker": { "model": "gpt-5.4" },
    "reviewer": { "model": "gpt-5.4" },
    "oracle": { "model": "gpt-5.4" }
  }
}
```

If configured models don't exist, children inherit the parent session's model
(safe fallback). Run `/subagents-doctor` for diagnostics.

## Execution Modes

- **Single**: `subagent({ agent: "scout", task: "find auth code" })`
- **Parallel**: `subagent({ tasks: [{ agent, task }, ...] })` — independent tasks
- **Chain**: `subagent({ chain: [{ agent, task }, ...] })` — sequential, `{previous}` placeholder
- **Async/background**: runs keep working after control returns; check with
  `subagent({ action: "status" })`

Useful commands: `/run <agent> [task]`, `/parallel`, `/chain`,
`/subagents-doctor` (setup diagnostics), `/subagents-models` (live model map),
`/subagents-fleet` (live run inspector), `/subagent-cost` (token/cost).

## Supervisor Coordination (contact_supervisor)

Children can talk back to the parent session **natively** (no pi-intercom
needed). When delegating tasks where the child might hit ambiguity, tell it
to ask rather than guess:

> "Have worker implement this plan. If it hits a product decision or gets
> blocked, have it ask me through contact_supervisor instead of assuming."

The child uses `contact_supervisor` with three reasons:

| reason | Behavior | Use when |
|--------|----------|----------|
| `need_decision` | **Blocking** — run pauses until parent replies | Child is blocked, uncertain, or faces a product/API/scope decision |
| `interview_request` | **Blocking** — structured questions, parent replies with JSON answers | Child needs multiple machine-readable answers at once |
| `progress_update` | **Non-blocking** — fire-and-forget | A discovery changes the plan meaningfully |

**Parent side:** pending requests appear in the session. Reply with
`subagent_supervisor({ action: "reply", replyTo, message })`; check pending
with `subagent_supervisor({ action: "pending" })`.

Do NOT use contact_supervisor for routine completion handoffs — the child
returns its final result normally.

## Delegation Guidelines

- **Delegate** when the subtask is self-contained, benefits from a specialized
  role, or would consume significant parent context (long sessions, /loop).
- **Don't delegate** trivial tasks (one read, one grep) or tasks needing
  back-and-forth with the user.
- **Verify** sub-agent output before acting on it — the parent stays
  responsible for the outcome.
- After implementation runs, consider a `reviewer` pass before summarizing.
- Children do not get the `subagent` tool by default (no infinite nesting);
  exceptions are explicitly allowlisted by the parent.
