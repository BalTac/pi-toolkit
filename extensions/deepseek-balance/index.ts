/**
 * DeepSeek Balance Extension v1.1
 *
 * Shows DeepSeek credit in the pi status bar:
 *   - Session cost (accumulated from token usage across all messages)
 *   - Remaining total balance (fetched from DeepSeek API: GET /user/balance)
 *   - Model input/output rate per 1M tokens (from pi's model registry,
 *     i.e. the same per-model `cost` configured in models-store.json)
 *     on the same line
 *
 * Auto-activates when the current model provider is "deepseek".
 * Balance is refreshed on session_start, after each turn, on model switch,
 * and cached for 60 seconds between calls.
 *
 * Optional config: ~/.pi/deepseek-balance.json
 *   { "apiKey": "sk-...", "enabled": true }
 *
 * If no config, the API key is auto-detected from:
 *   1. pi's auth.json (~/.pi/agent/auth.json) — where pi stores provider keys
 *   2. DEEPSEEK_API_KEY env var
 */

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ───────────────────────────────────────────────────────────────

interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface BalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

interface DeepSeekBalanceConfig {
  apiKey?: string;
  enabled?: boolean;
}

// ── Config ──────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), ".pi", "deepseek-balance.json");

function loadConfig(): DeepSeekBalanceConfig | null {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch { /* ignore */ }
  return null;
}

// ── Auth.json ───────────────────────────────────────────────────────────

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");

interface AuthEntry {
  type: string;
  key?: string;
}

function readAuthKey(provider: string): string | null {
  try {
    if (!fs.existsSync(AUTH_PATH)) return null;
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
    const entry = auth[provider] as AuthEntry | undefined;
    if (entry?.key) return entry.key;
  } catch { /* ignore */ }
  return null;
}

// ── API key resolution ──────────────────────────────────────────────────

function resolveApiKey(): string | null {
  // 1. Config override (~/.pi/deepseek-balance.json)
  const cfg = loadConfig();
  if (cfg?.apiKey) return cfg.apiKey;

  // 2. pi's auth.json — where pi stores provider API keys
  const authKey = readAuthKey("deepseek");
  if (authKey) return authKey;

  // 3. Environment variable
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;

  return null;
}

// ── Balance fetching ────────────────────────────────────────────────────

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const CACHE_MS = 60_000;

let cachedBalance: { data: BalanceResponse; at: number } | null = null;

async function fetchBalance(apiKey: string, signal?: AbortSignal): Promise<BalanceResponse | null> {
  if (cachedBalance && Date.now() - cachedBalance.at < CACHE_MS) {
    return cachedBalance.data;
  }
  try {
    const resp = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as BalanceResponse;
    cachedBalance = { data, at: Date.now() };
    return data;
  } catch {
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isDeepSeek(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "deepseek";
}

function calcSessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && (e.message as any)?.role === "assistant") {
      total += (e.message as any)?.usage?.cost?.total ?? 0;
    }
  }
  return total;
}

function fmtRate(v: number): string {
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3).replace(/\.?0+$/, "");
  return v.toFixed(4).replace(/\.?0+$/, "");
}

function fmtStatus(
  balance: BalanceResponse | null,
  cost: number,
  modelCost: { input: number; output: number } | null,
  theme: { fg: (color: any, text: string) => string },
): string {
  const fg = (c: string, t: string) => theme.fg(c, t);
  const parts: string[] = [];
  parts.push(fg("accent", "⚡") + " " + fg("dim", `$${cost.toFixed(3)} session`));

  if (modelCost && (modelCost.input > 0 || modelCost.output > 0)) {
    parts.push(fg("text", `in $${fmtRate(modelCost.input)}/M`));
    parts.push(fg("text", `out $${fmtRate(modelCost.output)}/M`));
  }

  if (balance && balance.balance_infos.length > 0) {
    const info = balance.balance_infos[0]!;
    const total = parseFloat(info.total_balance);
    const remaining = total - cost;
    const sym = info.currency === "CNY" ? "¥" : "$";

    if (balance.is_available) {
      parts.push(fg("success", `${sym}${remaining.toFixed(2)} left`));
    } else {
      parts.push(fg("warning", `low ${sym}${remaining.toFixed(2)}`));
    }
  }

  return parts.join(" · ");
}

// ── Extension ───────────────────────────────────────────────────────────

export default function deepseekBalance(pi: ExtensionAPI) {
  const STATUS_ID = "deepseek-balance";
  let active = false;

  async function refresh(ctx: ExtensionContext) {
    if (!isDeepSeek(ctx)) {
      if (active) { ctx.ui.setStatus(STATUS_ID, undefined); active = false; }
      return;
    }

    const apiKey = resolveApiKey();
    if (!apiKey) {
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", "DeepSeek: no API key"));
      active = true;
      return;
    }

    const cost = calcSessionCost(ctx);
    const balance = await fetchBalance(apiKey, ctx.signal);
    const m = ctx.model;
    const modelCost = m?.cost
      ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0 }
      : null;
    ctx.ui.setStatus(STATUS_ID, fmtStatus(balance, cost, modelCost, ctx.ui.theme));
    active = true;
  }

  pi.on("session_start", async (_event, ctx) => {
    cachedBalance = null;
    await refresh(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (active) { ctx.ui.setStatus(STATUS_ID, undefined); active = false; }
  });
}
