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
    note: "cost / budget tracking (/budget)",
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

function formatGuide(missing: Companion[]): string {
  if (missing.length === 0) {
    return "All pi-toolkit companion packages are installed. Nothing to do.";
  }
  const lines = missing.map(
    (c) => `- ${c.name} (${c.kind}) — ${c.note}\n    pi install ${c.source}`
  );
  return (
    "Missing pi-toolkit companion packages:\n\n" +
    lines.join("\n") +
    "\n\nInstall each with the command shown. " +
    "Required packages are needed for core features (web access, subagent delegation); recommended are optional."
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
      "List the required and recommended third-party companion packages for pi-toolkit that are not yet installed, with the exact 'pi install' commands.",
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
        details: { missing: missing.map((c) => ({ name: c.name, kind: c.kind, source: c.source })), total: missing.length },
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
