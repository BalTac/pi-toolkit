/**
 * Model Prices Extension v1.0
 *
 * Price-comparison model picker for pi.
 * Commands: /pricing  (aliases: /prices, /model-prices)
 *
 * Opens a full-screen list of every available model with its
 * per-1M-token rates (input / output / cache read) straight from
 * pi's model registry (the same `cost` configured in models-store.json).
 *
 *   → deepseek-v4-pro [deepseek] ✓  in $0.435/M · out $0.87/M · cache $0.0036/M · ctx 1M
 *
 * Keys:
 *   ↑/↓ or j/k ... navigate
 *   Enter .......... select model (switches to it immediately)
 *   Esc ............ close
 *   p .............. cycle sort: name → input price → output price
 *   Tab ............ toggle all/scoped scope (when scoped models are set)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildReport } from "./report.ts";

// ── Types ───────────────────────────────────────────────────────────────

interface CostLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface ModelLike {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  cost?: CostLike | null;
}

type ThemeLike = { fg: (color: any, text: string) => string };
type KeybindingsLike = { matches: (data: string, binding: any) => boolean };
type Done = (model: ModelLike | null) => void;

type SortMode = "name" | "in" | "out";

// DeepSeek V4 peak hours: 01:00-04:00 and 06:00-10:00 UTC (off-peak = half price).
const PEAK_MODEL_RE = /^deepseek-v4/;

function peakPeriod(now: Date = new Date()): "peak" | "off" {
  const h = now.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10) ? "peak" : "off";
}

// ── Formatting helpers ──────────────────────────────────────────────────

function fmtRate(v: number | undefined): string | null {
  if (v === undefined || v === null || !Number.isFinite(v)) return null;
  if (v === 0) return "0";
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3).replace(/\.?0+$/, "");
  return v.toFixed(4).replace(/\.?0+$/, "");
}

function fmtCtx(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** Price segments for one model, each with its theme color. */
function priceParts(m: ModelLike): { text: string; color: string }[] {
  const c = m.cost;
  const i = fmtRate(c?.input);
  const o = fmtRate(c?.output);
  const r = fmtRate(c?.cacheRead);

  if (i === null && o === null) return [{ text: "pricing n/a", color: "dim" }];
  if (i === "0" && o === "0") return [{ text: "free", color: "success" }];

  const parts: { text: string; color: string }[] = [];
  parts.push({ text: `in $${i ?? "—"}/M`, color: "text" });
  parts.push({ text: `out $${o ?? "—"}/M`, color: "text" });
  if (r && r !== "0") parts.push({ text: `cache $${r}/M`, color: "dim" });
  return parts;
}

function compareByCost(a: ModelLike, b: ModelLike, key1: "input" | "output", key2: "input" | "output"): number {
  const av = a.cost?.[key1] ?? Number.POSITIVE_INFINITY;
  const bv = b.cost?.[key1] ?? Number.POSITIVE_INFINITY;
  if (av !== bv) return av - bv;
  const a2 = a.cost?.[key2] ?? Number.POSITIVE_INFINITY;
  const b2 = b.cost?.[key2] ?? Number.POSITIVE_INFINITY;
  if (a2 !== b2) return a2 - b2;
  return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
}

// ── Picker component ────────────────────────────────────────────────────

class PricePicker {
  private theme: ThemeLike;
  private kb: KeybindingsLike;
  private done: Done;

  private all: ModelLike[];
  private scoped: ModelLike[];
  private current: ModelLike | undefined;

  private scope: "all" | "scoped";
  private sort: SortMode = "name";
  private period: "peak" | "off" | null;
  private models: ModelLike[] = [];
  private selectedIndex = 0;

  private width = 0;
  private lines: string[] = [];

  constructor(
    all: ModelLike[],
    scoped: ModelLike[],
    current: ModelLike | undefined,
    theme: ThemeLike,
    kb: KeybindingsLike,
    done: Done,
  ) {
    this.all = all;
    this.scoped = scoped;
    this.current = current;
    this.theme = theme;
    this.kb = kb;
    this.done = done;
    this.period = all.some((m) => PEAK_MODEL_RE.test(m.id)) ? peakPeriod() : null;
    this.scope = scoped.length > 0 ? "scoped" : "all";
    this.rebuild();
  }

  private isCurrent(m: ModelLike): boolean {
    return !!this.current && this.current.provider === m.provider && this.current.id === m.id;
  }

  private rebuild(): void {
    const source = this.scope === "scoped" && this.scoped.length > 0 ? this.scoped : this.all;
    const unique = new Map<string, ModelLike>();
    for (const m of source) unique.set(`${m.provider}/${m.id}`, m);

    const list = [...unique.values()];
    if (this.sort === "in") {
      list.sort((a, b) => compareByCost(a, b, "input", "output"));
    } else if (this.sort === "out") {
      list.sort((a, b) => compareByCost(a, b, "output", "input"));
    } else {
      list.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    }
    this.models = list;

    const idx = list.findIndex((m) => this.isCurrent(m));
    this.selectedIndex = idx >= 0 ? idx : Math.min(this.selectedIndex, Math.max(0, list.length - 1));
  }

  private cycleSort(): void {
    this.sort = this.sort === "name" ? "in" : this.sort === "in" ? "out" : "name";
    this.rebuild();
  }

  private toggleScope(): void {
    if (this.scoped.length === 0) return;
    this.scope = this.scope === "all" ? "scoped" : "all";
    this.rebuild();
  }

  invalidate(): void {
    this.width = 0;
    this.lines = [];
  }

  render(width: number): string[] {
    if (this.lines.length === 0 || this.width !== width) {
      this.renderLines(width);
    }
    return this.lines;
  }

  private renderLines(width: number): void {
    const theme = this.theme;
    const fg = (c: string, t: string) => theme.fg(c, t);
    const dim = (t: string) => fg("dim", t);

    const sortLabel = this.sort === "name" ? "name" : this.sort === "in" ? "input price" : "output price";
    const scopeLabel = this.scope === "scoped" && this.scoped.length > 0 ? "scoped" : "all";
    const peakBadge =
      this.period === "peak"
        ? fg("warning", "▲ peak")
        : this.period === "off"
          ? fg("success", "▼ off-peak")
          : "";

    const header = truncateToWidth(
      `${fg("accent", "Model prices")} ${dim(`· ${this.models.length} models`)} ${dim(
        `· sort: ${sortLabel} (p)`,
      )} ${dim(`· scope: ${scopeLabel}`)} ${dim("(tab)")}${peakBadge ? ` ${peakBadge}` : ""}`,
      width,
      dim("..."),
    );

    const hints = truncateToWidth(
      dim("↑/↓ navigate · enter select · esc close · p sort · tab scope"),
      width,
      dim("..."),
    );

    const rows: string[] = [];
    const maxVisible = 10;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.models.length - maxVisible));
    const end = Math.min(start + maxVisible, this.models.length);

    for (let i = start; i < end; i++) {
      const m = this.models[i]!;
      const isSelected = i === this.selectedIndex;
      const isCurrent = this.isCurrent(m);

      const prefix = isSelected ? fg("accent", "→ ") : "  ";
      const idText = isSelected ? fg("accent", m.id) : m.id;
      const provider = fg("muted", `[${m.provider}]`);
      const check = isCurrent ? fg("success", " ✓") : "";

      let line = `${prefix}${idText} ${provider}${check}`;
      const price = priceParts(m).map((p) => fg(p.color, p.text)).join(" · ");
      if (price) line += `  ${price}`;
      if (m.contextWindow && m.contextWindow > 0) line += `  ${dim(`ctx ${fmtCtx(m.contextWindow)}`)}`;

      rows.push(truncateToWidth(line, width, dim("...")));
    }

    if (start > 0 || end < this.models.length) {
      rows.push(fg("muted", `  (${this.selectedIndex + 1}/${this.models.length})`));
    }
    if (this.models.length === 0) {
      rows.push(fg("muted", "  No models available"));
    }

    this.lines = [header, "", ...rows, "", hints];
    this.width = width;
  }

  handleInput(data: string): void {
    const kb = this.kb;

    if (kb.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      if (this.models.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.models.length) % this.models.length;
        this.invalidate();
      }
    } else if (kb.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      if (this.models.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.models.length;
        this.invalidate();
      }
    } else if (kb.matches(data, "tui.input.tab")) {
      this.toggleScope();
      this.invalidate();
    } else if (matchesKey(data, "p")) {
      this.cycleSort();
      this.invalidate();
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.done(this.models[this.selectedIndex] ?? null);
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.done(null);
    }
  }
}

// ── Extension ───────────────────────────────────────────────────────────

export default function modelPrices(pi: ExtensionAPI) {
  const openPicker = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify("/prices requires the interactive TUI", "warning");
      return;
    }

    const all = ctx.modelRegistry.getAvailable() as ModelLike[];
    const scoped = ctx.scopedModels.map((s) => s.model as ModelLike);
    const current = ctx.model as ModelLike | undefined;

    const selected = await ctx.ui.custom<ModelLike | null>((tui, theme, kb, done) => {
      const picker = new PricePicker(all, scoped, current, theme, kb, done);
      return {
        render: (w: number) => picker.render(w),
        handleInput: (d: string) => {
          picker.handleInput(d);
          tui.requestRender();
        },
        invalidate: () => picker.invalidate(),
      };
    });

    if (selected) {
      const ok = await pi.setModel(selected as never);
      ctx.ui.notify(
        ok
          ? `Switched to ${selected.provider}/${selected.id}`
          : `No API key configured for ${selected.provider}/${selected.id}`,
        ok ? "info" : "error",
      );
    }
  };

  pi.registerCommand("pricing", {
    description: "Compare model prices (input/output per 1M tokens) and switch models",
    handler: openPicker,
  });

  pi.registerCommand("prices", {
    description: "Compare model prices (input/output per 1M tokens) and switch models",
    handler: openPicker,
  });

  pi.registerCommand("model-prices", {
    description: "Compare model prices (input/output per 1M tokens) and switch models",
    handler: openPicker,
  });

  // ── Pricing report (HTML) ────────────────────────────────────────────
  // /pricing-report [path] — generates a self-contained HTML page with
  // charts (by type, category, provider, price bracket), filters and a
  // multi-select comparison picker, then opens it in the browser.

  const generateReport = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const all = ctx.modelRegistry.getAvailable() as ModelLike[];
    if (all.length === 0) {
      ctx.ui.notify("No models available in the registry", "warning");
      return;
    }

    const html = buildReport(all);
    const arg = args.trim();
    const outPath = arg
      ? (path.isAbsolute(arg) ? arg : path.join(ctx.cwd, arg))
      : path.join(ctx.cwd, "pricing-report.html");

    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html, "utf-8");
    } catch (err) {
      ctx.ui.notify(`Could not write report: ${(err as Error).message}`, "error");
      return;
    }

    ctx.ui.notify(`Pricing report written to ${outPath}`, "info");

    // Best-effort: open in the default browser.
    try {
      if (process.platform === "win32") {
        await pi.exec("cmd", ["/c", "start", "", outPath], { timeout: 5000 });
      } else if (process.platform === "darwin") {
        await pi.exec("open", [outPath], { timeout: 5000 });
      } else {
        await pi.exec("xdg-open", [outPath], { timeout: 5000 });
      }
    } catch {
      /* opening is best-effort; the path was already reported */
    }
  };

  pi.registerCommand("pricing-report", {
    description: "Generate an HTML pricing report (charts by type/category/provider/price bracket) with model comparison picker",
    handler: generateReport,
  });

  pi.registerCommand("price-report", {
    description: "Generate an HTML pricing report (charts by type/category/provider/price bracket) with model comparison picker",
    handler: generateReport,
  });

  pi.registerCommand("pricing-html", {
    description: "Generate an HTML pricing report (charts by type/category/provider/price bracket) with model comparison picker",
    handler: generateReport,
  });
}
