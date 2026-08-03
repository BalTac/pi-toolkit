/**
 * Subagent Model Setup — detects missing subagent models and guides the user
 * through interactive configuration via pi's UI. No manual JSON editing needed.
 *
 * Runs on session_start in TUI mode. If pi-subagents is configured but the
 * specified models don't exist in the current environment, offers to
 * reconfigure via a 2-step selector (light + powerful).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

const POWERFUL_ROLES = ["planner", "worker", "reviewer", "oracle", "context-builder"];

// ── Model discovery (parse pi --list-models output) ────────────────────

interface ModelEntry {
  provider: string;
  id: string;
}

function listModels(): ModelEntry[] {
  try {
    const stdout = execFileSync("pi", ["--list-models"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    const lines = stdout.trim().split(/\r?\n/);
    // Skip header line
    const models: ModelEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^(\S+)\s+(\S+)/);
      if (m) models.push({ provider: m[1], id: m[2] });
    }
    return models;
  } catch {
    return [];
  }
}

function modelLabel(m: ModelEntry): string {
  return `${m.provider}/${m.id}`;
}

function modelExists(modelId: string, available: ModelEntry[]): boolean {
  for (const m of available) {
    // pi-subagents does fuzzy matching; we accept provider/id or bare id
    if (modelLabel(m) === modelId) return true;
    if (m.id === modelId) return true;
    if (modelId.includes("/")) {
      const [prov, mid] = modelId.split("/");
      if (m.provider === prov && m.id === mid) return true;
    }
  }
  return false;
}

// ── Settings read/write ────────────────────────────────────────────────

function readSettings(): Record<string, any> | null {
  try {
    return fs.existsSync(SETTINGS_PATH)
      ? JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"))
      : null;
  } catch {
    return null;
  }
}

function writeSettings(s: Record<string, any>): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

// ── Extension ──────────────────────────────────────────────────────────

export default function subagentSetup(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return; // only interactive

    // ── Guard: pi-web-access dependency check ─────────────────────
    // pi-web-access is bundled inside pi-toolkit (see package.json).
    // 1. If it is ALSO installed top-level in settings.json, the two
    //    registrations of web_search will conflict — warn the user
    //    with the exact removal command (npm vs git source).
    // 2. If the bundled node_modules copy is missing, warn to reinstall.
    // 3. Migrate the legacy web-search config (~/.pi/agent/web-search/
    //    config.json, written by pi-toolkit ≤0.1.x) to the unified
    //    ~/.pi/web-search.json that pi-web-access reads — the old
    //    auto-migration lived in the removed web-search.ts extension.
    try {
      const settings = readSettings();
      const packages: (string | { source?: string })[] =
        (settings?.packages as (string | { source?: string })[]) ?? [];
      const topLevelPWA = packages.find((p) => {
        const src = typeof p === "string" ? p : p.source ?? "";
        return src.includes("pi-web-access");
      });
      if (topLevelPWA) {
        const src = typeof topLevelPWA === "string" ? topLevelPWA : (topLevelPWA.source ?? "");
        const removeCmd = src.startsWith("git:") || src.includes("github.com/nicobailon")
          ? "pi remove git:github.com/nicobailon/pi-web-access"
          : "pi remove npm:pi-web-access";
        ctx.ui.notify(
          "pi-toolkit: pi-web-access is now bundled inside pi-toolkit. " +
          `A separate install was detected (${src}). Remove it to avoid ` +
          `duplicate web_search registration: ${removeCmd}`,
          "warning"
        );
      }

      // Bundled copy present? (node_modules/pi-web-access next to this package)
      const pwaPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "node_modules",
        "pi-web-access"
      );
      if (!fs.existsSync(pwaPath)) {
        ctx.ui.notify(
          "pi-toolkit: bundled pi-web-access dependency not found. " +
          "Run 'pi update --extensions' to reinstall dependencies.",
          "warning"
        );
      }

      // Legacy web-search config migration (pi-toolkit ≤0.1.x)
      const LEGACY_WEBSEARCH_DIR = path.join(os.homedir(), ".pi", "agent", "web-search");
      const LEGACY_WEBSEARCH_PATH = path.join(LEGACY_WEBSEARCH_DIR, "config.json");
      const UNIFIED_WEBSEARCH_PATH = path.join(os.homedir(), ".pi", "web-search.json");
      if (!fs.existsSync(UNIFIED_WEBSEARCH_PATH) && fs.existsSync(LEGACY_WEBSEARCH_PATH)) {
        try {
          const legacy = JSON.parse(fs.readFileSync(LEGACY_WEBSEARCH_PATH, "utf-8")) as {
            provider?: string;
            fallbackChain?: string[];
            providers?: Record<string, { baseUrl?: string; apiKey?: string; enabled?: boolean }>;
          };
          const unified: Record<string, unknown> = {};
          if (legacy.provider) unified.searchProvider = legacy.provider;
          if (legacy.fallbackChain?.length) unified.fallbackChain = legacy.fallbackChain;
          if (legacy.providers?.searxng?.baseUrl) unified.searxngBaseUrl = legacy.providers.searxng.baseUrl;
          const otherProviders: Record<string, unknown> = {};
          if (legacy.providers) {
            for (const [name, pcfg] of Object.entries(legacy.providers)) {
              if (name !== "searxng" && pcfg && Object.keys(pcfg).length > 0) {
                otherProviders[name] = pcfg;
              }
            }
          }
          if (Object.keys(otherProviders).length > 0) unified.providers = otherProviders;
          if (Object.keys(unified).length > 0) {
            fs.mkdirSync(path.dirname(UNIFIED_WEBSEARCH_PATH), { recursive: true });
            fs.writeFileSync(UNIFIED_WEBSEARCH_PATH, JSON.stringify(unified, null, 2) + "\n", "utf-8");
            ctx.ui.notify(
              "pi-toolkit: migrated legacy web-search config to ~/.pi/web-search.json " +
              "(read by bundled pi-web-access).",
              "info"
            );
          }
        } catch (err) {
          ctx.ui.notify(
            `pi-toolkit: failed to migrate legacy web-search config: ${err instanceof Error ? err.message : String(err)}`,
            "warning"
          );
        }
      }
    } catch { /* non-critical guard — never break startup */ }

    const settings = readSettings();
    if (!settings?.subagents) return; // pi-subagents not configured

    const sub = settings.subagents;
    const defaultModel = sub.defaultModel as string | undefined;
    const overrides = sub.agentOverrides as Record<string, { model?: string }> | undefined;

    // Collect all model references
    const configured = new Set<string>();
    if (defaultModel) configured.add(defaultModel);
    if (overrides) {
      for (const o of Object.values(overrides)) {
        if (o?.model) configured.add(o.model);
      }
    }
    if (configured.size === 0) return;

    // Check availability
    const available = listModels();
    if (available.length === 0) return; // can't enumerate — skip

    const missing: string[] = [];
    for (const m of configured) {
      if (!modelExists(m, available)) missing.push(m);
    }
    if (missing.length === 0) return; // all models present, nothing to do

    // ── Missing models detected — offer setup ──────────────────────

    const wantSetup = await ctx.ui.confirm(
      "Subagent Model Setup",
      `Some configured subagent models are not available in this environment:\n` +
        missing.map((m) => `  ✗ ${m}`).join("\n") +
        `\n\nReconfigure now? (Choose light + powerful models for your subagents)`
    );

    if (!wantSetup) {
      ctx.ui.notify(
        `Subagent: ${missing.length} model(s) missing. Children will inherit the session model.`,
        "warning"
      );
      return;
    }

    // Build choices sorted by provider
    const choices = available
      .map((m) => modelLabel(m))
      .sort((a, b) => a.localeCompare(b));

    // Step 1: LIGHT model
    const lightPath = await ctx.ui.select(
      "Select LIGHT model (fast/cheap — scout, researcher, analyst, delegate):",
      choices
    );
    if (!lightPath) return;

    // Step 2: POWERFUL model
    const powerfulPath = await ctx.ui.select(
      "Select POWERFUL model (full capability — planner, worker, reviewer, oracle):",
      choices
    );
    if (!powerfulPath) return;

    // Write
    const newOverrides: Record<string, { model: string }> = {};
    for (const role of POWERFUL_ROLES) {
      newOverrides[role] = { model: powerfulPath };
    }
    // Preserve any non-model overrides (thinking, extensions, etc.)
    if (overrides) {
      for (const [role, cfg] of Object.entries(overrides)) {
        if (!POWERFUL_ROLES.includes(role) && cfg?.model) {
          newOverrides[role] = { model: cfg.model };
        }
      }
    }

    settings.subagents = {
      ...sub,
      defaultModel: lightPath,
      agentOverrides: newOverrides,
    };
    writeSettings(settings);

    ctx.ui.notify(
      `Subagent models saved: light="${lightPath}", powerful="${powerfulPath}". /reload to apply.`,
      "info"
    );
  });
}
