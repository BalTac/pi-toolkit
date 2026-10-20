/**
 * pi-toolkit Post-Install Guide
 *
 * pi-toolkit ships NO third-party pi packages. Required and recommended
 * companion packages (web access, subagents, intercom, usage, budget, remote
 * SSH, knowledge base) must be installed separately. This extension surfaces
 * them so nothing is silently missing:
 *
 *   - On session_start (TUI), a toast lists any missing companions.
 *   - A tool (`pi_toolkit_install_guide`) returns the same list with the
 *     exact `pi install` commands — useful when pi-toolkit is installed or
 *     updated from inside a pi session, so the LLM sees the guidance.
 *   - A `/pi-toolkit-deps` command prints it on demand.
 *
 * Companion packages are read from `~/.pi/agent/settings.json` `packages`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

interface Companion {
  /** The `pi install` spec, e.g. "npm:pi-subagents". */
  source: string;
  /** Human-readable name. */
  name: string;
  kind: "required" | "recommended";
  /** Optional grouping; companions without one fall back to their kind. */
  category?: string;
  note: string;
}

const COMPANIONS: Companion[] = [
  {
    source: "npm:pi-web-access",
    name: "pi-web-access",
    kind: "required",
    note: "web search / content fetching (web_search, fetch_content, source_check)",
  },
  {
    source: "npm:pi-subagents",
    name: "pi-subagents",
    kind: "required",
    note: "subagent delegation + contact_supervisor",
  },
  {
    source: "npm:pi-intercom",
    name: "pi-intercom",
    kind: "recommended",
    note: "cross-session messaging",
  },
  {
    source: "npm:@narumitw/pi-usage",
    name: "pi-usage",
    kind: "recommended",
    note: "provider usage / credit dashboard (/usage)",
  },
  {
    source: "npm:pi-agent-budget",
    name: "pi-agent-budget",
    kind: "recommended",
    note: "cost / budget tracking (/budget); needs the better-sqlite3 pin in ~/.pi/agent/npm/package.json (overrides + allowScripts) or the extension fails to load — see README step 2",
  },
  {
    source: "npm:pi-ssh-remote",
    name: "pi-ssh-remote",
    kind: "recommended",
    note: "persistent remote SSH workspaces (remote tool / /remote)",
  },
  {
    source: "npm:@zosmaai/pi-llm-wiki",
    name: "pi-llm-wiki",
    kind: "recommended",
    note: "Karpathy LLM-wiki knowledge base: compounding project + personal vault, lint and recall (/wiki-init, /wiki-ingest, wiki_lint)",
  },
  {
    source: "npm:@vanillagreen/pi-caveman",
    name: "pi-caveman",
    kind: "recommended",
    note: "caveman speaking style: terser replies on demand (/caveman), off by default; output-side only, ~-27% output tokens per call measured",
  },
  {
    source: "git:github.com/DietrichGebert/ponytail",
    name: "ponytail",
    kind: "recommended",
    note: "lazy senior dev mode: one pi extension injects the ruleset every turn + /ponytail lite|full|ultra, /ponytail-review, /ponytail-audit, /ponytail-debt, /ponytail-gain, /ponytail-help",
  },
  {
    source: "npm:@bacnh85/pi-ponytail",
    name: "pi-ponytail",
    kind: "recommended",
    note: "alternative fork of the ponytail above: same ruleset, but it also injects it into subagent children (scout/worker/planner) via a tool_call hook; prefer upstream unless you need that",
  },
  // ── computer-use ────────────────────────────────────────────────────────
  // Driving the machine itself: desktop apps and a real browser. Listed
  // together because they overlap in practice (open the browser, navigate,
  // download a file is still "using the PC") and because choosing between
  // them is the actual decision — see each note.
  {
    source: "npm:@injaneity/pi-computer-use",
    name: "pi-computer-use",
    kind: "recommended",
    category: "computer-use",
    note:
      "observe and drive desktop apps and a CDP browser: find_roots, observe_ui, search_ui, expand_ui, inspect_ui, act_ui, read_text, wait_for, launch_browser, navigate_browser, evaluate_browser. Browser pages use the Chrome/Helium accessibility tree, not screenshots. Needs /reload after install; the Windows helper self-installs to ~/.pi/agent/helpers/pi-computer-use/. Known limits measured on Win11: no download API at all (page never saved, Downloads untouched), typeText/setText truncate at ~31 chars in Notepad's WinUI editor (use clipboard + Ctrl+V), and search_ui rejects CDP page states",
  },
  {
    source: "npm:pi-playwright",
    name: "pi-playwright",
    kind: "recommended",
    category: "computer-use",
    note:
      "same territory from the Playwright side: open/goto/snapshot/find/click/fill/pdf/state-save via a skill. Pick it for downloads, which pi-computer-use cannot do at all (page.on('download') + saveAs()), and for persistent logged-in sessions (storageState). Two manual steps are required because the published package ships neither the CLI dep nor a browser: `cd ~/.pi/agent/npm/node_modules/pi-playwright && npm install && npx playwright install chromium`. Note that plain Playwright is 403'd by eBay; drive real Chrome via connectOverCDP for that",
  },
  {
    source: "npm:@agent-sh/computer-use-linux",
    name: "computer-use-linux",
    kind: "recommended",
    category: "computer-use",
    note:
      "Linux-only alternative to pi-computer-use: AT-SPI semantic trees, screenshots, EWMH window targeting and Wayland/X11 input, plus an MCP server. Prefer it over pi-computer-use when the desktop is Linux; keep pi-computer-use for macOS/Windows",
  },
];

function normalizeSource(spec: string): string {
  // Strip @version / @ref for comparison: "npm:pi-subagents@1.2.3" -> "npm:pi-subagents".
  return spec.replace(/@[^@/\\]+$/, "").trim();
}

function readInstalled(): Set<string> {
  const set = new Set<string>();
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    const pkgs = (s.packages as (string | { source?: string })[]) ?? [];
    for (const p of pkgs) {
      const src = typeof p === "string" ? p : (p.source ?? "");
      if (src) set.add(normalizeSource(src));
    }
  } catch {
    /* never break startup */
  }
  return set;
}

function isInstalled(c: Companion, installed: Set<string>): boolean {
  if (installed.has(normalizeSource(c.source))) return true;
  // Accept git sources for the same package: e.g. git:github.com/nicobailon/pi-web-access
  const name = c.source.replace(/^npm:/, "");
  for (const src of installed) {
    if (src === name || src.endsWith("/" + name) || src.endsWith(":" + name)) return true;
  }
  return false;
}

function listMissing(installed: Set<string>): Companion[] {
  return COMPANIONS.filter((c) => !isInstalled(c, installed));
}

function groupOf(c: Companion): string {
  return c.category ?? (c.kind === "required" ? "core" : "general");
}

const GROUP_TITLES: Record<string, string> = {
  core: "Core — required",
  general: "General — recommended",
  "computer-use": "Computer use — recommended",
};

function formatGuide(missing: Companion[]): string {
  if (missing.length === 0) {
    return "All pi-toolkit companion packages are installed. Nothing to do.";
  }

  const order: string[] = [];
  const buckets = new Map<string, Companion[]>();
  for (const c of missing) {
    const g = groupOf(c);
    if (!buckets.has(g)) {
      buckets.set(g, []);
      order.push(g);
    }
    buckets.get(g)!.push(c);
  }

  const blocks = order.map((g) => {
    const lines = buckets.get(g)!.map(
      (c) => `- ${c.name} (${c.kind}) — ${c.note}\n    pi install ${c.source}`
    );
    return `${GROUP_TITLES[g] ?? g}\n${lines.join("\n")}`;
  });

  return (
    "Missing pi-toolkit companion packages:\n\n" +
    blocks.join("\n\n") +
    "\n\nInstall each with the command shown. " +
    "Required packages are needed for core features (web access, subagent delegation); recommended are optional. " +
    "Computer-use packages all drive the machine itself — they overlap, so install the one that matches your platform and task " +
    "(pi-computer-use for macOS/Windows desktop + browser, computer-use-linux on Linux, pi-playwright for downloads and logged-in sessions)."
  );
}

export default function installGuide(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      const missing = listMissing(readInstalled());
      if (missing.length === 0) return;
      const hasRequired = missing.some((c) => c.kind === "required");
      const type = hasRequired ? "warning" : "info";
      ctx.ui.notify(
        "pi-toolkit: missing companion packages — " +
          missing.map((c) => `${c.name} (${c.kind})`).join(", ") +
          ". Run /pi-toolkit-deps or call pi_toolkit_install_guide for install commands.",
        type
      );
    } catch {
      /* never break startup */
    }
  });

  pi.registerTool({
    name: "pi_toolkit_install_guide",
    label: "pi-toolkit Install Guide",
    description:
      "List the required and recommended third-party companion packages for pi-toolkit that are not yet installed, grouped by category (computer use included), with the exact 'pi install' commands.",
    promptSnippet:
      "After installing or updating pi-toolkit, call this tool to see which companion packages still need installing.",
    promptGuidelines: [
      "Use pi_toolkit_install_guide after installing/updating pi-toolkit to know what else to install.",
      "Install any missing required packages; recommended ones are optional.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const missing = listMissing(readInstalled());
      const text = formatGuide(missing);
      return {
        content: [{ type: "text", text }],
        details: { missing: missing.map((c) => ({ name: c.name, kind: c.kind, category: groupOf(c), source: c.source })), total: missing.length },
      };
    },
  });

  pi.registerCommand("pi-toolkit-deps", {
    description: "Show missing required/recommended companion packages with install commands.",
    handler: async (_args, ctx) => {
      const missing = listMissing(readInstalled());
      const text = formatGuide(missing);
      ctx.ui.notify(text, missing.length === 0 ? "info" : "warning");
    },
  });
}
