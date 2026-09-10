/**
 * DeepSeek Rates Extension v2.0
 *
 * Shows DeepSeek *model rates* in the pi status bar:
 *   - Input/output rate per 1M tokens for the selected model (from pi's model
 *     registry, i.e. the same per-model `cost` configured in models-store.json)
 *   - Peak/off-peak indicator for DeepSeek V4 models (peak hours:
 *     01:00-04:00 and 06:00-10:00 UTC, off-peak = half price)
 *
 * Removed in v2.0 (2026-09-10): session cost and remaining credit. Other
 * extensions display those (pi-usage / pi-agent-budget) and this one stays
 * focused on what they don't show. Side effect: the extension is now fully
 * local — no network calls, no API key, no config file. The historical
 * `~/.pi/deepseek-balance.json` (apiKey / cnyToUsd / enabled) is no longer read.
 *
 * Auto-activates when the current model provider is "deepseek".
 * Refreshed on session_start, after each turn and on model switch; when there
 * is nothing to show (no rates, no peak info) the status is cleared.
 */

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Peak / off-peak ────────────────────────────────────────────────────
// DeepSeek V4 peak hours: 01:00-04:00 and 06:00-10:00 UTC.
// All other hours are off-peak, priced at half the peak rate.
const PEAK_MODEL_RE = /^deepseek-v4/;

function peakPeriod(now: Date = new Date()): "peak" | "off" {
  const h = now.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10) ? "peak" : "off";
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isDeepSeek(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "deepseek";
}

function fmtRate(v: number): string {
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3).replace(/\.?0+$/, "");
  return v.toFixed(4).replace(/\.?0+$/, "");
}

/**
 * Status text: selected-model rates + peak/off-peak. Empty string when there is
 * nothing to show (caller clears the status instead of rendering blank space).
 */
function fmtStatus(
  modelCost: { input: number; output: number } | null,
  period: "peak" | "off" | null,
  theme: { fg: (color: any, text: string) => string },
): string {
  const fg = (c: string, t: string) => theme.fg(c, t);
  const parts: string[] = [];

  if (modelCost && (modelCost.input > 0 || modelCost.output > 0)) {
    parts.push(fg("text", `in $${fmtRate(modelCost.input)}/M`));
    parts.push(fg("text", `out $${fmtRate(modelCost.output)}/M`));
  }

  if (period === "peak") {
    parts.push(fg("warning", "▲ peak"));
  } else if (period === "off") {
    parts.push(fg("success", "▼ off-peak"));
  }

  return parts.join(" · ");
}

// ── Extension ───────────────────────────────────────────────────────────

export default function deepseekBalance(pi: ExtensionAPI) {
  const STATUS_ID = "deepseek-balance";
  let active = false;

  function refresh(ctx: ExtensionContext) {
    if (!isDeepSeek(ctx)) {
      if (active) { ctx.ui.setStatus(STATUS_ID, undefined); active = false; }
      return;
    }

    const m = ctx.model;
    const modelCost = m?.cost
      ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0 }
      : null;
    const period = m && PEAK_MODEL_RE.test(m.id) ? peakPeriod() : null;
    const text = fmtStatus(modelCost, period, ctx.ui.theme);

    if (!text) {
      // Nothing to show (no rates configured, no peak window) → stay quiet.
      if (active) { ctx.ui.setStatus(STATUS_ID, undefined); active = false; }
      return;
    }

    ctx.ui.setStatus(STATUS_ID, text);
    active = true;
  }

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (active) { ctx.ui.setStatus(STATUS_ID, undefined); active = false; }
  });
}
