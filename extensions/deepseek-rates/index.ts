/**
 * DeepSeek Rates Extension v3.0
 *
 * Shows DeepSeek *model rates* in the pi status bar:
 *   - input / output / cache-hit rate per 1M tokens for the selected model,
 *     resolved from the period currently in effect (peak or off-peak)
 *   - live peak/off-peak badge
 *
 * Data layer: see `rates.ts` (shared with the `model-prices` extension).
 *   - Rates + peak schedule come from the official pricing page (DeepSeek
 *     exposes no pricing API); the live model list comes from `GET /models`.
 *   - The peak/off-peak badge is re-evaluated on a 5-minute cycle. That is pure
 *     local clock math: no network.
 *   - Prices are fetched only when the cache is older than a day (PRICES_TTL_MS).
 *   - Falls back to pi's model registry (`ctx.model.cost`) when no fetched rates
 *     match the selected model, so the status never goes blank.
 *   - The refresh timer is started on demand and cleared on session_shutdown.
 *
 * Note: v2.x ignored the "Monday through Friday" part of the peak schedule and
 * matched models with /^deepseek-v4/, which hid the badge for `deepseek-flash`.
 * Both are fixed here: the weekday rule is honoured and any model with fetched
 * rates gets a peak badge.
 *
 * Removed in v2.0 (2026-09-10): session cost and remaining credit. Other
 * extensions display those (pi-usage / pi-agent-budget).
 */

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { currentPeriod, ensureRates, getRates, ratesFor, type ModelRates, type Period } from "./rates.ts";

// Re-exported for tests and backwards compatibility.
export { parsePricing, peakPeriod } from "./rates.ts";

const STATUS_ID = "deepseek-rates";
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes — re-evaluate the peak badge

// ── Formatting ──────────────────────────────────────────────────────────

function fmtRate(v: number): string {
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3).replace(/\.?0+$/, "");
  return v.toFixed(4).replace(/\.?0+$/, "");
}

function fmtStatus(
  rates: ModelRates | null,
  fallback: { input: number; output: number } | null,
  period: Period,
  ratio: number | null,
  theme: { fg: (color: any, text: string) => string },
): string {
  const fg = (c: string, t: string) => theme.fg(c, t);
  const parts: string[] = [];

  if (rates) {
    parts.push(fg("text", `in $${fmtRate(rates.cacheMiss[period])}/M`));
    parts.push(fg("text", `out $${fmtRate(rates.output[period])}/M`));
    parts.push(fg("text", `cache $${fmtRate(rates.cacheHit[period])}/M`));
  } else if (fallback && (fallback.input > 0 || fallback.output > 0)) {
    // registry rates (may be stale)
    parts.push(fg("text", `in $${fmtRate(fallback.input)}/M`));
    parts.push(fg("text", `out $${fmtRate(fallback.output)}/M`));
  }

  // session cache hit-ratio: share of input tokens served from the KV cache
  if (ratio !== null) {
    const pct = Math.round(ratio * 100);
    const color = pct >= 70 ? "success" : pct >= 40 ? "text" : "warning";
    parts.push(fg(color, `⚡ ${pct}% cached`));
  }

  if (period === "peak") parts.push(fg("warning", "▲ peak"));
  else parts.push(fg("success", "▼ off-peak"));

  return parts.join(" · ");
}

// ── Extension ───────────────────────────────────────────────────────────

export default function deepseekRates(pi: ExtensionAPI) {
  let active = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastCtx: ExtensionContext | null = null;

  // Session cache accounting: input tokens served from the KV cache (hit) vs
  // processed from scratch (miss). Seeded from the session file so a resumed
  // session keeps the ratio built up so far.
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;

  function resetUsage(): void {
    cacheHitTokens = 0;
    cacheMissTokens = 0;
  }

  function accountUsage(usage: { input?: number; cacheRead?: number } | undefined): void {
    if (!usage) return;
    cacheHitTokens += usage.cacheRead ?? 0;
    cacheMissTokens += usage.input ?? 0;
  }

  function cachedRatio(): number | null {
    const total = cacheHitTokens + cacheMissTokens;
    if (total <= 0) return null;
    return cacheHitTokens / total;
  }

  /** Sum usage from the session file (bounded: skips very large files). */
  function seedUsageFromSession(ctx: ExtensionContext): void {
    resetUsage();
    try {
      const file = (
        ctx as unknown as { sessionManager?: { getSessionFile?: () => string | undefined } }
      ).sessionManager?.getSessionFile?.();
      if (!file) return;
      if (fs.statSync(file).size > 40 * 1024 * 1024) return;
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.includes('"usage"')) continue;
        try {
          const entry = JSON.parse(line) as {
            message?: { usage?: { input?: number; cacheRead?: number } };
          };
          accountUsage(entry.message?.usage);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* seeding is best-effort */
    }
  }

  function ensureTimer(): void {
    if (timer) return;
    timer = setInterval(() => {
      // 5-minute cycle: refresh the peak/off-peak badge (local clock math),
      // and pull prices only when the cache is older than a day.
      safeRender(lastCtx);
      void ensureRates().then(() => safeRender(lastCtx));
    }, REFRESH_MS);
    // do not keep the process alive only for this timer
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function clearStatus(ctx: ExtensionContext): void {
    if (active) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      active = false;
    }
  }

  function render(ctx: ExtensionContext | null): void {
    if (!ctx) return;
    if (ctx.model?.provider !== "deepseek") {
      stopTimer(); // nothing to keep polling for
      clearStatus(ctx);
      return;
    }

    const data = getRates();
    const m = ctx.model;
    const period = currentPeriod(data);
    const rates = m ? ratesFor(data, m.id) : null;
    const fallback = m?.cost ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0 } : null;
    const text = fmtStatus(rates, fallback, period, cachedRatio(), ctx.ui.theme);

    if (!text) {
      clearStatus(ctx);
      return;
    }
    ctx.ui.setStatus(STATUS_ID, text);
    active = true;
  }

  // Rendering from an async continuation can land after the session was torn
  // down (shutdown/reload): the captured ctx is then stale and every getter
  // throws. Skipping the stale ctx avoids an unhandled rejection that would
  // abort headless (`pi -p`) runs with a non-zero exit code.
  function safeRender(ctx: ExtensionContext | null): void {
    if (!ctx || ctx !== lastCtx) return;
    try {
      render(ctx);
    } catch {
      /* ctx invalidated mid-flight (session shutdown/reload); ignore */
    }
  }

  function tick(ctx: ExtensionContext): void {
    lastCtx = ctx;
    render(ctx);
    if (ctx.model?.provider === "deepseek") {
      ensureTimer();
      // ensureRates() is a no-op unless the cached prices are older than a day.
      void ensureRates().then(() => safeRender(ctx));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    seedUsageFromSession(ctx);
    tick(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => tick(ctx));
  pi.on("model_select", async (_event, ctx) => tick(ctx));

  // Cache accounting: every assistant message carries token usage.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = (
      event.message as { usage?: { input?: number; cacheRead?: number } }
    ).usage;
    if (!usage) return;
    accountUsage(usage);
    render(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTimer();
    clearStatus(ctx);
    lastCtx = null;
  });
}
