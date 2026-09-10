/**
 * Auto-Compact by Percent + Context Memory + Token-aware recall
 *
 * PART 1 - Percentage based auto-compaction (default 38%)
 *   Triggers Pi's auto-compaction when context usage crosses a *percentage* of the
 *   active model's context window, instead of relying only on the built-in absolute
 *   reserve (`contextTokens > contextWindow - reserveTokens`).
 *
 *   Why a percentage: `reserveTokens` is an absolute token count, so with a
 *   1,000,000-token model the default reserve of 16k means compaction only fires at
 *   ~98% of the window, and one fixed large reserve would be bigger than the whole
 *   window of a 128k/200k model (forcing compaction on every turn).
 *
 *   Why 38%: "Intelligence Degradation in Long-Context LLMs" (arXiv:2601.15300)
 *   finds a cliff-like collapse at 40-50% of the context window (critical point
 *   43.2%, -45.5% F1, no recovery beyond). Performance is stable below 40%, so the
 *   trigger sits under that onset with a small margin. The finding is from
 *   Qwen2.5-7B/128k, so the exact fraction is model-specific: the *shape* (a cliff,
 *   not a gradual decline) is the part that generalises.
 *
 *   Hooks `agent_settled` (Pi is fully idle there), because `ctx.compact()` awaits an
 *   internal abort() - harmless when idle, fatal to an in-flight turn if called mid-run.
 *
 * PART 2 - Context memory (durable, detailed, recallable)
 *   Before every compaction a detailed synthesis of the context being discarded is
 *   written to disk, together with a full-fidelity JSONL archive of the raw messages.
 *   The synthesis is ALSO used as the compaction summary, so the live context keeps
 *   the detail and knows where the full memory lives.
 *
 *     ~/.pi/agent/context-memory/<id>.memory.md     detailed synthesis (recall this)
 *     ~/.pi/agent/context-memory/<id>.archive.jsonl full-fidelity raw messages
 *     ~/.pi/agent/context-memory/index.md            append-only index
 *
 *   Recall: tool `context_memory` (list/read/search/raw) and `/memoria`
 *   (list/show/search/recall/raw/dir). `/memoria recall <id>` injects the memory into
 *   the next prompt.
 *
 * PART 3 - Tokens are the scarce resource, not bytes
 *   A recalled memory is injected into the LIVE context, so every memory has a token
 *   price. Therefore: the synthesis is capped in tokens, the token cost is recorded in
 *   the frontmatter and shown by `list`, tool reads are token-capped, and `recall`
 *   refuses to inject a memory that would push the context past the trigger
 *   (`recall <id> force` overrides).
 *
 * PART 4 - keepRecentTokens auto-adjusted per model
 *   `keepRecentTokens` is also an absolute count: 60k is harmless on a 1M window (6%)
 *   but is 47% of a 128k window, i.e. above the trigger - which would make the
 *   post-compaction context immediately re-trigger compaction in a loop. So it is
 *   recomputed from the active model's window and written to settings.json (applies
 *   from the next session), and `check()` refuses to auto-compact while the current
 *   setting is above the trigger (loop guard, with a one-off warning).
 *
 * Config file (created on first use):
 *   ~/.pi/agent/auto-compact.json
 *   { "enabled": true, "percent": 38, "memory": true, "memoryMaxTokens": 4000,
 *     "toolTokenCap": 2000, "keepRecent": { "auto": true, "ratio": 0.15, "min": 8000, "max": 60000 } }
 *
 * Commands:
 *   /autocompact [<percent>|on|off|status|memory-on|memory-off|keeprecent-auto|keeprecent <n>]
 *   /memoria [list|show|search|recall <id> [force]|raw|dir]
 *
 * Env overrides: PI_AUTO_COMPACT_PERCENT, PI_CONTEXT_MEMORY=0.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, estimateTokens, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-compact.json");
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const MEMORY_DIR = join(homedir(), ".pi", "agent", "context-memory");
const QUARANTINE_DIR = join(MEMORY_DIR, "quarantine");
const INDEX_PATH = join(MEMORY_DIR, "index.md");
const ENV_PERCENT = "PI_AUTO_COMPACT_PERCENT";
const ENV_MEMORY = "PI_CONTEXT_MEMORY";
const STATUS_KEY = "auto-compact";

/** Trigger at 38% of the window: below the 40% degradation onset (arXiv:2601.15300). */
const DEFAULT_PERCENT = 38;
const MIN_PERCENT = 10;
const MAX_PERCENT = 80;

const DEFAULT_MEMORY_MAX_TOKENS = 4000;
const DEFAULT_TOOL_TOKEN_CAP = 2000;

const DEFAULT_KEEP_RECENT = { auto: true, ratio: 0.15, min: 8000, max: 60000 };
/** Keep the post-compaction floor safely below the trigger (loop guard margin). */
const KEEP_RECENT_HEADROOM = 0.8;

/** Fallback instructions when the built-in summarizer runs (context memory disabled). */
const SUMMARY_INSTRUCTIONS =
	"Preserve operational details verbatim: file paths, shell commands, hostnames/ports, " +
	"table and column names, error messages, and open decisions. Keep credential *identifiers* " +
	"(which key/file holds a secret) but never inline secret values. Keep the standard sections.";

/**
 * Prompt for the durable context memory. Deliberately dense rather than verbose:
 * the artefact is injected back into the live context when recalled, so its token
 * price matters as much as its completeness.
 */
const MEMORY_PROMPT = `You are writing a CONTEXT MEMORY: the durable, detailed record of a working session that will replace the conversation history and may be re-read weeks later to resume the work.

Write in the SAME LANGUAGE as the conversation.

Rules:
- Be concrete and operational, not narrative. Prefer facts over prose.
- Be DENSE: this file is re-injected into a live context when recalled, so length costs budget. Target 1000-2500 tokens, hard cap 4000. No repetition, no filler, no restating the same fact twice.
- Record verbatim (do not paraphrase): file paths, shell commands, hostnames, ports, URLs, service names, SQL/table/column names, function and class names, error messages, version numbers.
- Secrets: name the file/key that holds a value (e.g. "token in config.ini -> madbot_bot_token") but NEVER write the secret value itself.
- Date every chronological item when a date/time is present in the conversation.
- If a detail is not in the conversation, write nothing about it. Never invent.
- Use bullet lists and small tables, not paragraphs.

Required sections:
## Obiettivo e contesto
## Stato attuale (fatto / in corso / bloccato)
## Decisioni chiave e motivazione
## Dettagli operativi
Sottosezioni: percorsi e file toccati, comandi eseguiti (verbatim, con esito), endpoint/host/porte/servizi, schema dati (tabelle, colonne), configurazioni.
## Problemi aperti e domande
## Sicurezze, backup e rollback
Percorsi dei backup, procedure di ripristino, cosa non toccare.
## Prossimi passi (ordine consigliato)
## Frammenti da non perdere
Citazioni verbatim brevi di comandi, query, output o passaggi critici.`;

interface KeepRecentConfig {
	auto: boolean;
	ratio: number;
	min: number;
	max: number;
}

interface AutoCompactConfig {
	enabled: boolean;
	percent: number;
	memory: boolean;
	memoryMaxTokens: number;
	toolTokenCap: number;
	keepRecent: KeepRecentConfig;
	retention: RetentionConfig;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_PERCENT;
	return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(value * 10) / 10));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function loadConfig(): AutoCompactConfig {
	const config: AutoCompactConfig = {
		enabled: true,
		percent: DEFAULT_PERCENT,
		memory: true,
		memoryMaxTokens: DEFAULT_MEMORY_MAX_TOKENS,
		toolTokenCap: DEFAULT_TOOL_TOKEN_CAP,
		keepRecent: { ...DEFAULT_KEEP_RECENT },
		retention: { ...DEFAULT_RETENTION },
	};

	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			if (raw && typeof raw === "object") {
				if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
				if (typeof raw.percent === "number") config.percent = clampPercent(raw.percent);
				if (typeof raw.memory === "boolean") config.memory = raw.memory;
				if (typeof raw.memoryMaxTokens === "number") {
					config.memoryMaxTokens = clampNumber(raw.memoryMaxTokens, 500, 32000, DEFAULT_MEMORY_MAX_TOKENS);
				}
				if (typeof raw.toolTokenCap === "number") {
					config.toolTokenCap = clampNumber(raw.toolTokenCap, 200, 32000, DEFAULT_TOOL_TOKEN_CAP);
				}
				if (raw.keepRecent && typeof raw.keepRecent === "object") {
					if (typeof raw.keepRecent.auto === "boolean") config.keepRecent.auto = raw.keepRecent.auto;
					if (typeof raw.keepRecent.ratio === "number") {
						config.keepRecent.ratio = clampNumber(raw.keepRecent.ratio, 0.02, 0.5, DEFAULT_KEEP_RECENT.ratio);
					}
					if (typeof raw.keepRecent.min === "number") {
						config.keepRecent.min = clampNumber(raw.keepRecent.min, 1000, 200000, DEFAULT_KEEP_RECENT.min);
					}
					if (typeof raw.keepRecent.max === "number") {
						config.keepRecent.max = clampNumber(raw.keepRecent.max, 1000, 500000, DEFAULT_KEEP_RECENT.max);
					}
				}
				if (raw.retention && typeof raw.retention === "object") {
					if (typeof raw.retention.enabled === "boolean") config.retention.enabled = raw.retention.enabled;
					if (typeof raw.retention.budgetMB === "number") {
						config.retention.budgetMB = clampNumber(raw.retention.budgetMB, 0, 1000000, DEFAULT_RETENTION.budgetMB);
					}
					if (typeof raw.retention.rotateAfterDays === "number") {
						config.retention.rotateAfterDays = clampNumber(raw.retention.rotateAfterDays, 0, 36500, DEFAULT_RETENTION.rotateAfterDays);
					}
					if (typeof raw.retention.deleteAfterDays === "number") {
						config.retention.deleteAfterDays = clampNumber(raw.retention.deleteAfterDays, 0, 36500, DEFAULT_RETENTION.deleteAfterDays);
					}
					if (typeof raw.retention.protectProjectDays === "number") {
						config.retention.protectProjectDays = clampNumber(raw.retention.protectProjectDays, 0, 36500, DEFAULT_RETENTION.protectProjectDays);
					}
					if (typeof raw.retention.compress === "boolean") config.retention.compress = raw.retention.compress;
				}
			}
		}
	} catch (error) {
		// A broken config must never stop Pi from starting.
	}

	const percentFromEnv = process.env[ENV_PERCENT];
	if (percentFromEnv) {
		const parsed = Number.parseFloat(percentFromEnv);
		if (Number.isFinite(parsed)) config.percent = clampPercent(parsed);
	}
	const memoryFromEnv = process.env[ENV_MEMORY];
	if (memoryFromEnv === "0" || memoryFromEnv === "false") config.memory = false;

	return config;
}

function saveConfig(config: AutoCompactConfig): void {
	try {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch (error) {
		// Read-only home / permissions: keep the in-memory value, just don't persist.
	}
}

// ---------------------------------------------------------------------------
// Context-memory archive retention: usage index + logrotate-style rotation.
// All functions take an injectable `dir` so they can be unit-tested in isolation.

interface RetentionConfig {
	enabled: boolean;
	/** Total raw-archive budget; 0 disables budget-driven rotation. */
	budgetMB: number;
	/** Rotate archives older than N days (0 disables age-driven rotation). */
	rotateAfterDays: number;
	/** Delete already-rotated archives older than N days (0 = never delete). */
	deleteAfterDays: number;
	/** Memories recalled within N days (or of the current project) are protected. */
	protectProjectDays: number;
	/** true = gzip on rotation, false = drop the raw archive outright. */
	compress: boolean;
}

const DEFAULT_RETENTION: RetentionConfig = {
	enabled: true,
	budgetMB: 200,
	rotateAfterDays: 30,
	deleteAfterDays: 90,
	protectProjectDays: 14,
	compress: true,
};

interface RetentionEntry {
	created: string;
	project: string;
	bytes: number;
	recalls: number;
	lastRecall: string | null;
	archive: string | null;
	status: "active" | "rotated" | "deleted";
	/** When the entry was rotated; `deleteAfterDays` counts from here (falls back to `created` for old entries). */
	rotatedAt?: string | null;
}

interface RetentionIndex {
	version: number;
	entries: Record<string, RetentionEntry>;
}

interface SweepReport {
	rotated: string[];
	deleted: string[];
	protectedIds: string[];
	totalBytesBefore: number;
	totalBytesAfter: number;
	savedBytes: number;
}

const RETENTION_FILENAME = "retention.json";
const DAY_MS = 86_400_000;

function retentionPath(dir: string): string {
	return join(dir, RETENTION_FILENAME);
}

function readRetention(dir: string): RetentionIndex {
	const empty: RetentionIndex = { version: 1, entries: {} };
	try {
		const path = retentionPath(dir);
		if (!existsSync(path)) return empty;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object" || !raw.entries || typeof raw.entries !== "object") return empty;
		empty.version = typeof raw.version === "number" ? raw.version : 1;
		empty.entries = raw.entries as Record<string, RetentionEntry>;
	} catch (error) {
		/* A broken retention index must never affect compaction or startup. */
	}
	return empty;
}

function writeRetention(dir: string, index: RetentionIndex): void {
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const path = retentionPath(dir);
		const temporary = `${path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
	} catch (error) {
		/* Non-fatal: retention state just won't persist this time. */
	}
}

function registerMemory(dir: string, id: string, meta: { created: string; project: string; bytes: number; archive: string }): void {
	try {
		const index = readRetention(dir);
		const previous = index.entries[id];
		index.entries[id] = {
			created: meta.created,
			project: meta.project,
			bytes: Math.max(0, Math.floor(meta.bytes) || 0),
			recalls: typeof previous?.recalls === "number" ? previous.recalls : 0,
			lastRecall: previous?.lastRecall ?? null,
			archive: meta.archive,
			status: previous?.status === "rotated" || previous?.status === "deleted" ? previous.status : "active",
			rotatedAt: previous?.rotatedAt ?? null,
		};
		writeRetention(dir, index);
	} catch (error) {
		/* Non-fatal. */
	}
}

function recordRecall(dir: string, id: string, now: number = Date.now()): void {
	try {
		const index = readRetention(dir);
		const entry = index.entries[id];
		if (!entry) return;
		entry.recalls = (typeof entry.recalls === "number" ? entry.recalls : 0) + 1;
		entry.lastRecall = new Date(now).toISOString();
		writeRetention(dir, index);
	} catch (error) {
		/* Non-fatal. */
	}
}

function entryAgeDays(entry: RetentionEntry, now: number): number {
	const created = Date.parse(entry.created);
	if (!Number.isFinite(created)) return 0;
	return Math.max(0, (now - created) / DAY_MS);
}

/**
 * Days since rotation. The deletion window must start when the entry is rotated,
 * not when it was created: otherwise an old archive that gets rotated today would
 * be deleted tomorrow instead of after `deleteAfterDays`. Falls back to `created`
 * for entries written before `rotatedAt` existed.
 */
function entryRotatedAgeDays(entry: RetentionEntry, now: number): number {
	const anchor = entry.rotatedAt ? Date.parse(entry.rotatedAt) : Date.parse(entry.created);
	if (!Number.isFinite(anchor)) return 0;
	return Math.max(0, (now - anchor) / DAY_MS);
}

function isProtected(
	entry: RetentionEntry,
	id: string,
	newestId: string | undefined,
	now: number,
	currentProject: string | undefined,
	protectProjectDays: number,
): boolean {
	if (id === newestId) return true;
	if (currentProject && entry.project === currentProject) return true;
	if (protectProjectDays > 0 && entry.lastRecall) {
		const last = Date.parse(entry.lastRecall);
		if (Number.isFinite(last) && (now - last) / DAY_MS < protectProjectDays) return true;
	}
	return false;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

/** Short human-readable "bilancio" of the memory archives (counts + on-disk bytes). */
function retentionSummary(dir: string): string {
	try {
		const index = readRetention(dir);
		const ids = Object.keys(index.entries);
		let active = 0;
		let rotated = 0;
		let deleted = 0;
		let diskBytes = 0;
		const top: { id: string; recalls: number }[] = [];
		for (const id of ids) {
			const entry = index.entries[id];
			if (entry.status === "active") active += 1;
			else if (entry.status === "rotated") rotated += 1;
			else if (entry.status === "deleted") deleted += 1;
			top.push({ id, recalls: typeof entry.recalls === "number" ? entry.recalls : 0 });
		}
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".archive.jsonl") || name.endsWith(".archive.jsonl.gz")) {
				try {
					diskBytes += statSync(join(dir, name)).size;
				} catch (error) {
					/* skip */
				}
			}
		}
		top.sort((a, b) => b.recalls - a.recalls);
		const top5 = top
			.slice(0, 5)
			.filter((t) => t.recalls > 0)
			.map((t) => `${t.id} (${t.recalls})`)
			.join(", ");
		return `attive ${active} · ruotate ${rotated} · eliminate ${deleted} · archivi ${formatBytes(diskBytes)}` +
			(top5 ? ` · top richiamate: ${top5}` : "");
	} catch (error) {
		return "bilancio non disponibile";
	}
}

function sweepRetention(
	dir: string,
	config: RetentionConfig,
	opts?: { now?: number; currentProject?: string; dryRun?: boolean },
): SweepReport {
	const now = opts?.now ?? Date.now();
	const dryRun = opts?.dryRun === true;
	const currentProject = opts?.currentProject;
	const report: SweepReport = {
		rotated: [],
		deleted: [],
		protectedIds: [],
		totalBytesBefore: 0,
		totalBytesAfter: 0,
		savedBytes: 0,
	};

	if (!config.enabled) return report;

	const index = readRetention(dir);
	const ids = Object.keys(index.entries);
	if (ids.length === 0) return report;

	let newestId: string | undefined;
	let newestCreated = -Infinity;
	for (const id of ids) {
		const created = Date.parse(index.entries[id].created);
		if (Number.isFinite(created) && created > newestCreated) {
			newestCreated = created;
			newestId = id;
		}
	}

	const archiveBytesOnDisk = (id: string): number => {
		const entry = index.entries[id];
		if (!entry.archive) return 0;
		try {
			if (existsSync(join(dir, entry.archive))) return entry.bytes;
		} catch (error) {
			/* fall through */
		}
		return 0;
	};

	report.totalBytesBefore = ids.reduce((sum, id) => {
		return index.entries[id].status === "active" ? sum + archiveBytesOnDisk(id) : sum;
	}, 0);

	let remaining = report.totalBytesBefore;
	const budgetBytes = config.budgetMB > 0 ? config.budgetMB * 1024 * 1024 : Number.POSITIVE_INFINITY;

	const sortKey = (id: string): number => {
		const entry = index.entries[id];
		const recall = entry.lastRecall ? Date.parse(entry.lastRecall) : 0;
		return Number.isFinite(recall) ? recall : 0;
	};
	const sorted = [...ids].sort((a, b) => {
		const ra = sortKey(a);
		const rb = sortKey(b);
		if (ra !== rb) return ra - rb;
		return Date.parse(index.entries[a].created) - Date.parse(index.entries[b].created);
	});

	// Rotate one entry: gzip (or drop) its raw archive, flip the status to "rotated".
	// Returns false when the filesystem step fails, so the caller can try the next entry.
	const rotateEntry = (id: string): boolean => {
		const entry = index.entries[id];
		const bytes = archiveBytesOnDisk(id);
		const archiveFile = entry.archive ? join(dir, entry.archive) : undefined;
		if (!dryRun) {
			try {
				if (archiveFile && existsSync(archiveFile)) {
					if (config.compress) {
						const gzFile = `${archiveFile}.gz`;
						writeFileSync(gzFile, gzipSync(readFileSync(archiveFile)));
						unlinkSync(archiveFile);
						entry.archive = `${entry.archive}.gz`;
						const gzSize = statSync(gzFile).size;
						report.savedBytes += Math.max(0, bytes - gzSize);
					} else {
						unlinkSync(archiveFile);
						entry.archive = null;
						report.savedBytes += bytes;
					}
				} else {
					entry.archive = null;
				}
				entry.status = "rotated";
				entry.rotatedAt = new Date(now).toISOString();
			} catch (error) {
				/* Rotation failed for this entry: leave it active and move on. */
				return false;
			}
		} else {
			report.savedBytes += bytes;
		}
		report.rotated.push(id);
		remaining -= bytes;
		return true;
	};

	// Pass 1: rotate (active -> rotated) the unprotected entries.
	for (const id of sorted) {
		const entry = index.entries[id];
		if (entry.status !== "active") continue;
		if (isProtected(entry, id, newestId, now, currentProject, config.protectProjectDays)) {
			report.protectedIds.push(id);
			continue;
		}
		const ageDays = entryAgeDays(entry, now);
		const overBudget = remaining > budgetBytes;
		const agedOut = config.rotateAfterDays > 0 && ageDays > config.rotateAfterDays;
		if (!overBudget && !agedOut) continue;

		rotateEntry(id);
	}

	// Pass 1b (last resort): a single long-lived project protects every archive, so
	// Pass 1 alone would never enforce the budget and the disk would grow forever.
	// If we are still over budget, rotate protected entries too — oldest first, and
	// least-recently-recalled first, so the most-used memories are consumed last.
	// The newest entry is never rotated here.
	if (remaining > budgetBytes) {
		const recentRecallCutoff = config.protectProjectDays > 0 ? now - config.protectProjectDays * DAY_MS : 0;
		const recalledRecently = (id: string): number => {
			const last = index.entries[id].lastRecall ? Date.parse(index.entries[id].lastRecall) : 0;
			return Number.isFinite(last) && last > recentRecallCutoff ? 1 : 0;
		};
		const fallback = sorted
			.filter((id) => index.entries[id].status === "active" && id !== newestId)
			.sort((a, b) => {
				const ra = recalledRecently(a);
				const rb = recalledRecently(b);
				if (ra !== rb) return ra - rb;
				return sortKey(a) - sortKey(b);
			});
		for (const id of fallback) {
			if (remaining <= budgetBytes) break;
			rotateEntry(id);
		}
	}

	// Pass 2: delete (rotated -> deleted), age-based only.
	for (const id of sorted) {
		const entry = index.entries[id];
		if (entry.status !== "rotated") continue;
		if (isProtected(entry, id, newestId, now, currentProject, config.protectProjectDays)) {
			if (!report.protectedIds.includes(id)) report.protectedIds.push(id);
			continue;
		}
		const ageDays = entryRotatedAgeDays(entry, now);
		if (config.deleteAfterDays > 0 && ageDays > config.deleteAfterDays && id !== newestId) {
			if (!dryRun) {
				try {
					const file = entry.archive ? join(dir, entry.archive) : undefined;
					if (file && existsSync(file)) unlinkSync(file);
					entry.archive = null;
					entry.status = "deleted";
				} catch (error) {
					continue;
				}
			}
			report.deleted.push(id);
		}
	}

	if (!dryRun) writeRetention(dir, index);

	report.totalBytesAfter = ids.reduce((sum, id) => {
		return index.entries[id].status === "active" ? sum + archiveBytesOnDisk(id) : sum;
	}, 0);

	return report;
}

/** Pi's own token estimator, so counts stay consistent with how Pi measures context. */
function countTokens(text: string): number {
	if (!text) return 0;
	try {
		return estimateTokens({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: 0,
		} as never);
	} catch (error) {
		// Conservative fallback: ~4 characters per token.
		return Math.ceil(text.length / 4);
	}
}

/**
 * Cut `text` to roughly `maxTokens`.
 *
 * Line-based first (keeps markdown readable), then, if the next line alone would
 * blow the budget, a character-limited prefix of that line: memories can contain
 * very long single lines, and a pure line cut would return just the frontmatter.
 */
function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
	const total = countTokens(text);
	if (total <= maxTokens) return { text, truncated: false };

	const lines = text.split("\n");
	const kept: string[] = [];
	let used = 0;
	let index = 0;

	for (; index < lines.length; index += 1) {
		const lineTokens = countTokens(lines[index]);
		if (used + lineTokens > maxTokens) break;
		kept.push(lines[index]);
		used += lineTokens;
	}

	const remaining = maxTokens - used;
	if (index < lines.length && remaining > 50) {
		const line = lines[index];
		const lineTokens = countTokens(line);
		let chars = lineTokens > 0 ? Math.floor(line.length * (remaining / lineTokens) * 0.95) : line.length;
		chars = Math.max(200, chars);
		let slice = line.slice(0, chars);
		let guard = 0;
		while (countTokens(slice) > remaining && chars > 200 && guard < 10) {
			chars = Math.floor(chars * 0.7);
			slice = line.slice(0, chars);
			guard += 1;
		}
		kept.push(slice);
	}

	return { text: kept.join("\n"), truncated: true };
}

function formatTokens(value: number): string {
	return `${Math.round(value).toLocaleString("en-US")} tok`;
}

function ensureMemoryDir(): boolean {
	try {
		if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
		return true;
	} catch (error) {
		return false;
	}
}

function timestampId(sessionId: string): string {
	const now = new Date();
	const pad = (value: number, size = 2) => String(value).padStart(size, "0");
	const stamp =
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
		`_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const suffix = (sessionId || "nosession").replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "nosession";
	return `${stamp}_${suffix}`;
}

function toSortedArray(values: Set<string> | undefined): string[] {
	if (!values || typeof values.forEach !== "function") return [];
	const list: string[] = [];
	values.forEach((value: string) => list.push(value));
	return list.sort();
}

function listMemoryFiles(): string[] {
	try {
		if (!existsSync(MEMORY_DIR)) return [];
		return readdirSync(MEMORY_DIR)
			.filter((name) => name.endsWith(".memory.md"))
			.sort()
			.reverse();
	} catch (error) {
		return [];
	}
}

/** Parse the YAML-ish front matter of a memory file into a flat object. */
function parseFrontMatter(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!match) return result;
	for (const line of match[1].split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (key) result[key] = value;
	}
	return result;
}

/** Resolve a memory or archive file, also looking inside the quarantine directory. */
function readMemory(idOrFile: string): { id: string; path: string; text: string } | undefined {
	const clean = idOrFile.replace(/[^a-zA-Z0-9_\-.]/g, "");
	const candidates = [
		join(MEMORY_DIR, clean),
		join(MEMORY_DIR, `${clean}.memory.md`),
		join(MEMORY_DIR, `${clean}.archive.jsonl`),
		join(QUARANTINE_DIR, clean),
		join(QUARANTINE_DIR, `${clean}.archive.jsonl`),
	];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				return {
					id: clean.replace(/\.(memory|archive)\.(md|jsonl)$/, ""),
					path: candidate,
					text: readFileSync(candidate, "utf8"),
				};
			}
		} catch (error) {
			/* keep looking */
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// keepRecentTokens: read/write the global setting, recomputed per model window

interface SettingsCache {
	mtimeMs: number;
	keepRecentTokens?: number;
}

function readSettingsCache(): SettingsCache {
	try {
		const stat = statSync(SETTINGS_PATH);
		if (!stat.isFile()) return { mtimeMs: 0 };
		const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		const value = raw?.compaction?.keepRecentTokens;
		return { mtimeMs: stat.mtimeMs, keepRecentTokens: typeof value === "number" ? value : undefined };
	} catch (error) {
		return { mtimeMs: 0 };
	}
}

let settingsCache: SettingsCache = { mtimeMs: -1 };

function getKeepRecentFromSettings(): number | undefined {
	try {
		const stat = statSync(SETTINGS_PATH);
		if (stat.mtimeMs !== settingsCache.mtimeMs) settingsCache = readSettingsCache();
	} catch (error) {
		if (settingsCache.mtimeMs === -1) settingsCache = { mtimeMs: 0 };
	}
	return settingsCache.keepRecentTokens;
}

/**
 * Desired keepRecentTokens for a window: `ratio` of the window, clamped to
 * [min, max], and never above `headroom * trigger` so a compaction can always
 * bring the context back under the trigger (no compaction loop).
 */
function computeKeepRecent(contextWindow: number, config: AutoCompactConfig): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return config.keepRecent.min;
	const byRatio = Math.round(contextWindow * config.keepRecent.ratio);
	const clamped = clampNumber(byRatio, config.keepRecent.min, config.keepRecent.max, config.keepRecent.min);
	const ceiling = Math.floor((config.percent / 100) * contextWindow * KEEP_RECENT_HEADROOM);
	return Math.max(1000, Math.min(clamped, ceiling));
}

/** Persist keepRecentTokens into settings.json (other keys preserved). Applies next session. */
function writeKeepRecentToSettings(value: number): boolean {
	try {
		let raw: Record<string, unknown> = {};
		if (existsSync(SETTINGS_PATH)) raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		if (!raw || typeof raw !== "object") raw = {};
		const compaction = (raw.compaction && typeof raw.compaction === "object" ? raw.compaction : {}) as Record<string, unknown>;
		if (compaction.keepRecentTokens === value) return false;
		compaction.keepRecentTokens = value;
		raw.compaction = compaction;
		const temporary = `${SETTINGS_PATH}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
		renameSync(temporary, SETTINGS_PATH);
		settingsCache = { mtimeMs: -1 };
		getKeepRecentFromSettings();
		return true;
	} catch (error) {
		return false;
	}
}

export default function autoCompactPercent(pi: ExtensionAPI) {
	const config = loadConfig();
	let compacting = false;
	let pendingInjection: string | undefined;
	let warnedKeepRecent = false;

	const clearStatus = (ctx: ExtensionContext): void => {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch (error) {
			/* UI not available in this mode */
		}
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void => {
		try {
			ctx.ui.notify(message, level);
		} catch (error) {
			/* UI not available in this mode */
		}
	};

	/** Sync keepRecentTokens with the active model's window (settings.json, next session). */
	const syncKeepRecent = (ctx: ExtensionContext): void => {
		if (!config.keepRecent.auto) return;
		const model = ctx.model;
		if (!model || !model.contextWindow) return;
		const desired = computeKeepRecent(model.contextWindow, config);
		const current = getKeepRecentFromSettings();
		if (current === desired) return;
		const written = writeKeepRecentToSettings(desired);
		if (written) {
			notify(
				ctx,
				`keepRecentTokens ${current ?? "?"} → ${desired} per ${model.provider}/${model.id} ` +
					`(finestra ${model.contextWindow.toLocaleString("en-US")} tok, ${Math.round(config.keepRecent.ratio * 100)}%). ` +
					`Attivo dalla prossima sessione; in questa vale ${current ?? "il valore precedente"}.`,
				"info",
			);
		}
	};

	/**
	 * Loop guard: if the kept tail is already at/above the trigger, a compaction
	 * cannot bring the context back under it, so compacting again would just loop.
	 */
	const keepRecentBlocksCompaction = (ctx: ExtensionContext): string | undefined => {
		const model = ctx.model;
		if (!model || !model.contextWindow) return undefined;
		const keepRecent = getKeepRecentFromSettings();
		if (typeof keepRecent !== "number") return undefined;
		const limit = (config.percent / 100) * model.contextWindow;
		if (keepRecent < limit) return undefined;
		const percent = ((keepRecent / model.contextWindow) * 100).toFixed(1);
		return (
			`keepRecentTokens=${keepRecent.toLocaleString("en-US")} è il ${percent}% della finestra ` +
			`(${model.contextWindow.toLocaleString("en-US")} tok) e supera la soglia del ${config.percent}%: ` +
			`la compaction non riuscirebbe a scendere sotto la soglia (loop). ` +
			`Auto-compaction saltata; il valore corretto verrà scritto in settings.json ` +
			`(${computeKeepRecent(model.contextWindow, config)} per ${model.id}) e sarà attivo dalla prossima sessione.`
		);
	};

	// ---------------------------------------------------------------- PART 1
	// Percentage based auto-compaction

	const check = (ctx: ExtensionContext): void => {
		if (!config.enabled || compacting) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || usage.tokens === null) return;
		if (usage.percent < config.percent) return;

		const blocked = keepRecentBlocksCompaction(ctx);
		if (blocked) {
			if (!warnedKeepRecent) {
				warnedKeepRecent = true;
				notify(ctx, blocked, "warning");
				syncKeepRecent(ctx);
			}
			return;
		}

		const percentAtTrigger = usage.percent;
		const tokensAtTrigger = usage.tokens;

		compacting = true;
		try {
			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.ui.theme.fg("accent", `\u21e9 auto-compact ${percentAtTrigger.toFixed(1)}%`),
			);
		} catch (error) {
			/* UI not available in this mode */
		}

		ctx.compact({
			customInstructions: SUMMARY_INSTRUCTIONS,
			onComplete: () => {
				compacting = false;
				clearStatus(ctx);
				notify(
					ctx,
					`Auto-compaction done (triggered at ${percentAtTrigger.toFixed(1)}%, ` +
						`~${tokensAtTrigger.toLocaleString("en-US")} tokens).`,
					"info",
				);
			},
			onError: (error: Error) => {
				compacting = false;
				clearStatus(ctx);
				notify(ctx, `Auto-compaction failed: ${error.message}`, "error");
			},
		});
	};

	// Pi is idle here and will not continue on its own: safe place to compact.
	pi.on("agent_settled", async (_event, ctx) => {
		check(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		syncKeepRecent(ctx);
		try {
			const report = sweepRetention(MEMORY_DIR, config.retention, {
				currentProject: (() => {
					try {
						return ctx.sessionManager.getCwd();
					} catch (error) {
						return process.cwd();
					}
				})(),
			});
			if (report.rotated.length > 0 || report.deleted.length > 0) {
				notify(
					ctx,
					`Retention memorie: ${report.rotated.length} archivio/i ruotati, ${report.deleted.length} eliminati` +
						` (risparmiati ${formatBytes(report.savedBytes)}).`,
					"info",
				);
			}
		} catch (error) {
			/* retention must never break startup */
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		warnedKeepRecent = false;
		syncKeepRecent(ctx);
	});

	// ---------------------------------------------------------------- PART 2/3
	// Context memory: written right before the compaction consumes the messages

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal, reason } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		if (allMessages.length === 0) return;

		const sessionId = (() => {
			try {
				return ctx.sessionManager.getSessionId();
			} catch (error) {
				return undefined;
			}
		})();
		const sessionName = (() => {
			try {
				return ctx.sessionManager.getSessionName() ?? undefined;
			} catch (error) {
				return undefined;
			}
		})();
		const cwd = (() => {
			try {
				return ctx.sessionManager.getCwd();
			} catch (error) {
				return process.cwd();
			}
		})();

		const id = timestampId(sessionId || "");
		const memoryPath = join(MEMORY_DIR, `${id}.memory.md`);
		const archivePath = join(MEMORY_DIR, `${id}.archive.jsonl`);
		const fileOps = preparation.fileOps || {
			read: new Set<string>(),
			written: new Set<string>(),
			edited: new Set<string>(),
		};
		const filesRead = toSortedArray(fileOps.read);
		const filesWritten = toSortedArray(fileOps.written);
		const filesEdited = toSortedArray(fileOps.edited);

		// 1. Full-fidelity archive first: even if summarization fails, nothing is lost.
		let archiveWritten = false;
		if (config.memory && ensureMemoryDir()) {
			try {
				const lines = allMessages.map((message: unknown, index: number) => {
					try {
						return JSON.stringify({ index, message });
					} catch (error) {
						return JSON.stringify({ index, message: "[unserializable message]" });
					}
				});
				writeFileSync(archivePath, `${lines.join("\n")}\n`, "utf8");
				archiveWritten = true;
				try {
					const archiveBytes = statSync(archivePath).size;
					registerMemory(MEMORY_DIR, id, {
						created: new Date().toISOString(),
						project: cwd,
						bytes: archiveBytes,
						archive: `${id}.archive.jsonl`,
					});
				} catch (error) {
					/* retention bookkeeping is best-effort */
				}
			} catch (error) {
				archiveWritten = false;
			}
		}

		if (!config.memory) return;

		// 2. Detailed synthesis (used both as the memory file and as the live summary).
		const model = ctx.model;
		if (!model) return;

		const conversationText = serializeConversation(convertToLlm(allMessages));
		const previousContext = previousSummary ? `\n\n---\nSintesi precedente (contesto da mantenere):\n${previousSummary}` : "";

		const prompt = `${MEMORY_PROMPT}${previousContext}

Metadati seduta:
- id memoria: ${id}
- cwd: ${cwd}
- token da riassumere: ${tokensBefore}
- motivo della compaction: ${reason}
- messaggi: ${allMessages.length}${sessionName ? `\n- nome sessione: ${sessionName}` : ""}

<conversation>
${conversationText}
</conversation>`;

		const summaryMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			},
		];

		let summary = "";
		let usage: unknown;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: summaryMessages },
				{ maxTokens: config.memoryMaxTokens, signal, cacheRetention: "none", sessionId: uuidv7() },
			);
			summary = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			usage = response.usage;
		} catch (error) {
			if (!signal.aborted) {
				notify(ctx, "Context memory: sintesi non riuscita, uso la compaction standard (archivio salvato).", "warning");
			}
			return;
		}

		if (!summary) return;

		// The live summary stays in the context window, so it is bounded by the cap:
		// the file keeps the full text, the live context keeps the budgeted part.
		const memoryTokens = countTokens(summary);
		const overCap = memoryTokens > config.memoryMaxTokens;
		const liveBody = overCap
			? `${truncateToTokens(summary, config.memoryMaxTokens).text}\n\n` +
				`[... sintesi troncata nel contesto vivo: file completo (${formatTokens(memoryTokens)}) in \`${memoryPath}\`]`
			: summary;

		// 3. Write the memory file + index.
		let memoryWritten = false;
		if (ensureMemoryDir()) {
			try {
				const relative = (value: string) => value.replace(/\\/g, "/").replace(/^.*\/Netbook_Telemania\//, "");
				const frontMatter = [
					"---",
					`id: ${id}`,
					`created: ${new Date().toISOString()}`,
					`session_id: ${sessionId || "unknown"}`,
					`session_name: ${sessionName || ""}`,
					`cwd: ${cwd}`,
					`trigger: ${reason}`,
					`tokens_before: ${tokensBefore}`,
					`tokens: ${memoryTokens}`,
					`messages_summarized: ${allMessages.length}`,
					`model: ${model.provider}/${model.id}`,
					`files_read: ${filesRead.length}`,
					`files_written: ${filesWritten.length}`,
					`files_edited: ${filesEdited.length}`,
					"---",
				].join("\n");

				const body = [
					frontMatter,
					"",
					`# Context memory \`${id}\``,
					"",
					`> Sintesi dettagliata del contesto consumato dalla compaction (\`${reason}\`), ${new Date().toISOString()}.`,
					`> Costo di richiamo: **${formatTokens(memoryTokens)}**${overCap ? ` — sopra il cap di ${formatTokens(config.memoryMaxTokens)}, valuta la lettura a sezioni` : ""}.`,
					`> Archivio integrale dei messaggi: \`${archivePath}\`${archiveWritten ? "" : " (non scritto)"}.`,
					`> Richiamabile con: \`/memoria recall ${id}\` oppure col tool \`context_memory\`.`,
					"",
					summary,
					"",
					"## File toccati",
					"",
					`### Letti (${filesRead.length})`,
					...(filesRead.length === 0 ? ["(nessuno)"] : filesRead.slice(0, 200).map((file) => `- \`${relative(file)}\``)),
					"",
					`### Scritti (${filesWritten.length})`,
					...(filesWritten.length === 0
						? ["(nessuno)"]
						: filesWritten.slice(0, 200).map((file) => `- \`${relative(file)}\``)),
					"",
					`### Modificati (${filesEdited.length})`,
					...(filesEdited.length === 0
						? ["(nessuno)"]
						: filesEdited.slice(0, 200).map((file) => `- \`${relative(file)}\``)),
					"",
				].join("\n");

				writeFileSync(memoryPath, body, "utf8");
				memoryWritten = true;

				const indexEntry =
					`- [${id}](${id}.memory.md) | ${new Date().toISOString()} | ${reason} | ` +
					`${tokensBefore.toLocaleString("en-US")} tok prima | memoria ${memoryTokens} tok | ` +
					`${allMessages.length} msg | ${cwd}${sessionName ? ` | ${sessionName}` : ""}\n`;
				if (!existsSync(INDEX_PATH)) {
					writeFileSync(
						INDEX_PATH,
						"# Context memory index\n\nUna riga per compaction: id, data, motivo, token prima, costo di richiamo della memoria, messaggi, cwd.\n\n",
						"utf8",
					);
				}
				appendFileSync(INDEX_PATH, indexEntry, "utf8");
			} catch (error) {
				memoryWritten = false;
			}
		}

		notify(
			ctx,
			memoryWritten
				? `Context memory salvata (${formatTokens(memoryTokens)} di richiamo): ${memoryPath}`
				: "Context memory: file non scritto (permessi?), la compaction procede comunque.",
			memoryWritten ? (overCap ? "warning" : "info") : "warning",
		);

		// The live summary points at the durable memory so a future turn can pull it back.
		const liveSummary =
			`> Context memory \`${id}\` (${formatTokens(memoryTokens)} di richiamo; dettagli con \`/memoria recall ${id}\` o col tool \`context_memory\`).\n` +
			`> Archivio integrale: \`${archivePath}\`\n\n${liveBody}`;

		return {
			compaction: {
				summary: liveSummary,
				firstKeptEntryId,
				tokensBefore,
				usage,
			},
		};
	});

	// ---------------------------------------------------------------- Recall

	pi.registerTool({
		name: "context_memory",
		label: "Context Memory",
		description:
			"Read the durable context memories written before each auto-compaction. " +
			"These files contain a detailed synthesis of work that was removed from the live context " +
			"(decisions, commands, paths, endpoints, open issues). Use it whenever the user refers to " +
			"something that is no longer in the conversation, or before answering about earlier work. " +
			"Content returned by this tool counts against the context budget, so reads are token-capped.",
		promptSnippet: "Read a detailed memory of context dropped by auto-compaction",
		promptGuidelines: [
			"Use context_memory with action=list when the user refers to earlier work that is no longer in the context window.",
			"Use context_memory with action=search to find where a topic, file or command was discussed in past compacted sessions.",
			"context_memory reads are token-capped on purpose: raise limit only when the smaller excerpt is not enough.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("search"), Type.Literal("raw")], {
				description: "list: index of memories; read: full memory text; search: find a string; raw: raw archived messages",
			}),
			id: Type.Optional(Type.String({ description: "Memory id or file name (for read/raw), e.g. 2026-09-10_091533_ab12cd" })),
			query: Type.Optional(Type.String({ description: "Text to search for (for search)" })),
			limit: Type.Optional(Type.Number({ description: "Max results/lines to return (search defaults to 40, read to a token cap)" })),
		}),
		async execute(_toolCallId, params) {
			const action = params.action;
			const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : undefined;

			if (action === "list") {
				const files = listMemoryFiles();
				if (files.length === 0) {
					return { content: [{ type: "text", text: `Nessuna context memory in ${MEMORY_DIR}.` }], details: {} };
				}
				const max = limit ?? 50;
				const rows = files.slice(0, max).map((file) => {
					try {
						const text = readFileSync(join(MEMORY_DIR, file), "utf8");
						const meta = parseFrontMatter(text);
						const title = /^## Obiettivo[^\n]*\n+([^\n]+)/m.exec(text)?.[1] ?? "";
						const tokens = Number(meta.tokens ?? 0);
						return `- ${file.replace(".memory.md", "")} | ${meta.created ?? "?"} | ${meta.trigger ?? "?"} | ` +
							`${Number(meta.tokens_before ?? 0).toLocaleString("en-US")} tok prima | costa ${tokens} tok` +
							`${title ? `\n    ${title.slice(0, 160)}` : ""}`;
					} catch (error) {
						return `- ${file} (illeggibile)`;
					}
				});
				return {
					content: [
						{
							type: "text",
							text: `Context memory in ${MEMORY_DIR} (${files.length} totali, mostrate ${rows.length}):\n${rows.join("\n")}`,
						},
					],
					details: { count: files.length },
				};
			}

			if (action === "search") {
				const query = (params.query ?? "").trim();
				if (!query) return { content: [{ type: "text", text: "Serve 'query'." }], details: {} };
				const max = limit ?? 40;
				const needle = query.toLowerCase();
				const matches: string[] = [];
				for (const file of listMemoryFiles()) {
					if (matches.length >= max) break;
					let text = "";
					try {
						text = readFileSync(join(MEMORY_DIR, file), "utf8");
					} catch (error) {
						continue;
					}
					const lines = text.split("\n");
					for (let index = 0; index < lines.length && matches.length < max; index += 1) {
						if (lines[index].toLowerCase().includes(needle)) {
							matches.push(`${file.replace(".memory.md", "")}:${index + 1}: ${lines[index].trim().slice(0, 300)}`);
						}
					}
				}
				return {
					content: [
						{
							type: "text",
							text: matches.length
								? `Trovate ${matches.length} righe per "${query}":\n${matches.join("\n")}`
								: `Nessuna occorrenza di "${query}" nelle context memory.`,
						},
					],
					details: { count: matches.length },
				};
			}

			// read / raw
			const id = (params.id ?? "").trim();
			if (!id) return { content: [{ type: "text", text: "Serve 'id' (usa action=list per l'elenco)." }], details: {} };

			const found = readMemory(action === "raw" ? `${id.replace(/\.memory\.md$/, "")}.archive.jsonl` : id);
			if (!found) {
				const files = listMemoryFiles().slice(0, 20).map((file) => file.replace(".memory.md", ""));
				return {
					content: [{ type: "text", text: `Memory "${id}" non trovata. Disponibili:\n${files.join("\n") || "(nessuna)"}` }],
					details: {},
				};
			}

			recordRecall(MEMORY_DIR, found.id);
			const fileTokens = countTokens(found.text);
			// Token-capped by default: whatever this returns lands in the live context.
			const tokenBudget = limit ? Math.max(limit, config.toolTokenCap) : config.toolTokenCap;
			const { text: body, truncated } = truncateToTokens(found.text, tokenBudget);
			const lines = found.text.split("\n").length;
			const note = truncated
				? `\n\n[... estratto troncato per budget di token: file completo ${formatTokens(fileTokens)} / ${lines} righe in ${found.path} — alza \`limit\` per leggere di più]`
				: "";
			return {
				content: [{ type: "text", text: `${found.path}\n\n${body}${note}` }],
				details: { path: found.path, lines, tokens: fileTokens, truncated },
			};
		},
	});

	pi.registerCommand("memoria", {
		description: "Elenco, lettura e richiamo delle context memory salvate prima delle compaction",
		getArgumentCompletions: (prefix: string) => {
			const options = ["list", "search", "recall", "show", "raw", "dir", "retention"];
			const matches = options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const sub = (parts[0] || "list").toLowerCase();
			const rest = parts.slice(1).join(" ").trim();
			const force = /\bforce\b/.test(rest);
			const target = rest.replace(/\bforce\b/, "").trim();

			if (sub === "dir") {
				notify(ctx, `Context memory: ${MEMORY_DIR}\nIndice: ${INDEX_PATH}\nQuarantena: ${QUARANTINE_DIR}`, "info");
				return;
			}

			if (sub === "list" || sub === "l") {
				const files = listMemoryFiles();
				if (files.length === 0) {
					notify(ctx, `Nessuna context memory in ${MEMORY_DIR}.`, "info");
					return;
				}
				const rows = files.slice(0, 15).map((file) => {
					try {
						const meta = parseFrontMatter(readFileSync(join(MEMORY_DIR, file), "utf8"));
						return `  ${file.replace(".memory.md", "")}  ${meta.trigger ?? "?"}  ` +
							`${Number(meta.tokens_before ?? 0).toLocaleString("en-US")} tok prima  costa ${Number(meta.tokens ?? 0)} tok`;
					} catch (error) {
						return `  ${file}`;
					}
				});
				notify(ctx, `Context memory (${files.length} totali):\n${rows.join("\n")}\n\nBilancio: ${retentionSummary(MEMORY_DIR)}\n\n/memoria show <id> | recall <id> | search <testo> | retention`, "info");
				return;
			}

			if (sub === "search" || sub === "s") {
				if (!rest) {
					notify(ctx, "Uso: /memoria search <testo>", "warning");
					return;
				}
				const needle = rest.toLowerCase();
				const matches: string[] = [];
				for (const file of listMemoryFiles()) {
					if (matches.length >= 15) break;
					let text = "";
					try {
						text = readFileSync(join(MEMORY_DIR, file), "utf8");
					} catch (error) {
						continue;
					}
					for (const line of text.split("\n")) {
						if (matches.length >= 15) break;
						if (line.toLowerCase().includes(needle)) {
							matches.push(`${file.replace(".memory.md", "")}: ${line.trim().slice(0, 180)}`);
						}
					}
				}
				notify(ctx, matches.length ? `Occorrenze di "${rest}":\n${matches.join("\n")}` : `Nessuna occorrenza di "${rest}".`, "info");
				return;
			}

			if (sub === "show" || sub === "read") {
				if (!target) {
					notify(ctx, "Uso: /memoria show <id>", "warning");
					return;
				}
				const found = readMemory(target);
				if (!found) {
					notify(ctx, `Memory "${target}" non trovata.`, "warning");
					return;
				}
				recordRecall(MEMORY_DIR, found.id);
				const tokens = countTokens(found.text);
				const { text: body, truncated } = truncateToTokens(found.text, config.toolTokenCap);
				notify(
					ctx,
					truncated ? `${body}\n\n[... troncato: file completo ${formatTokens(tokens)} in ${found.path}]` : body,
					"info",
				);
				return;
			}

			if (sub === "raw") {
				if (!target) {
					notify(ctx, "Uso: /memoria raw <id>", "warning");
					return;
				}
				const found = readMemory(`${target.replace(/\.memory\.md$/, "")}.archive.jsonl`);
				if (!found) {
					notify(ctx, `Archivio per "${target}" non trovato.`, "warning");
					return;
				}
				recordRecall(MEMORY_DIR, found.id);
				const tokens = countTokens(found.text);
				notify(
					ctx,
					`Archivio: ${found.path}\nDimensione: ${found.text.length} byte, ${formatTokens(tokens)} se letto tutto ` +
						`(NON va iniettato: leggilo a sezioni).`,
					"info",
				);
				return;
			}

			if (sub === "recall" || sub === "r" || sub === "usa") {
				if (!target) {
					notify(ctx, "Uso: /memoria recall <id> [force] — inietta il contenuto nel prossimo prompt", "warning");
					return;
				}
				const found = readMemory(target);
				if (!found) {
					notify(ctx, `Memory "${target}" non trovata.`, "warning");
					return;
				}

				recordRecall(MEMORY_DIR, found.id);
				// Token guard: a recall is injected into the LIVE context, so it must
				// not push the session past the compaction trigger.
				const tokens = countTokens(found.text);
				const usage = ctx.getContextUsage();
				if (usage && usage.percent !== null && usage.contextWindow > 0) {
					const projectedPercent = usage.percent + (tokens / usage.contextWindow) * 100;
					if (projectedPercent > config.percent && !force) {
						notify(
							ctx,
							`Richiamo annullato: il contesto è al ${usage.percent.toFixed(1)}% e questa memoria costa ${formatTokens(tokens)} ` +
								`(${projectedPercent.toFixed(1)}% stimato), oltre la soglia del ${config.percent}%.\n` +
								`Opzioni: \`/memoria recall ${target} force\` per iniettarla comunque, oppure \`/memoria show ${target}\` per leggerne solo un estratto.`,
							"warning",
						);
						return;
					}
				}

				pendingInjection = `## Context memory richiamata dall'utente: ${found.id}\nFile: ${found.path}\n\n${found.text}`;
				notify(
					ctx,
					`Memory ${found.id} caricata (${formatTokens(tokens)}): verrà iniettata nel prossimo prompt.`,
					"info",
				);
				return;
			}

			if (sub === "retention" || sub === "sweep") {
				const apply = /\b(apply|esegui|now)\b/.test(rest);
				const report = sweepRetention(MEMORY_DIR, config.retention, {
					currentProject: process.cwd(),
					dryRun: !apply,
				});
				const protectedNote =
					report.protectedIds.length > 0
						? `\nProtette: ${report.protectedIds.length} (progetto corrente, richiamate di recente o più recente).`
						: "";
				notify(
					ctx,
					`Retention memorie (${apply ? "ESEGUITA" : "dry-run — usa /memoria retention apply"}):\n` +
						`Ruotati: ${report.rotated.length}\n` +
						`Eliminati: ${report.deleted.length}\n` +
						`Archivi attivi: ${formatBytes(report.totalBytesBefore)}` +
						(apply ? ` → ${formatBytes(report.totalBytesAfter)}` : "") +
						` (${apply ? "risparmiati" : "risparmio stimato"} ~${formatBytes(report.savedBytes)})` +
						protectedNote +
						`\n\nBilancio: ${retentionSummary(MEMORY_DIR)}`,
					"info",
				);
				return;
			}

			notify(ctx, "Uso: /memoria [list|show <id>|search <testo>|recall <id> [force]|raw <id>|dir|retention]", "warning");
		},
	});

	// Injects a recalled memory into the next prompt.
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!pendingInjection) return;
		const content = pendingInjection;
		pendingInjection = undefined;
		return {
			message: {
				customType: "context-memory",
				content,
				display: true,
			},
		};
	});

	// ---------------------------------------------------------------- Threshold command

	pi.registerCommand("autocompact", {
		description: "Show or set the auto-compaction threshold (percent of context window)",
		getArgumentCompletions: (prefix: string) => {
			const options = ["status", "on", "off", "35", "38", "40", "memory-on", "memory-off", "keeprecent-auto", "keeprecent"];
			const matches = options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const arg = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ").trim();

			if (arg === "memory-on" || arg === "memory-off") {
				config.memory = arg === "memory-on";
				saveConfig(config);
				notify(ctx, `Context memory ${config.memory ? "attiva" : "disattiva"} (salvato).`, "info");
				return;
			}

			if (arg === "keeprecent-auto") {
				if (rest === "on" || rest === "off") {
					config.keepRecent.auto = rest === "on";
					saveConfig(config);
					if (config.keepRecent.auto) syncKeepRecent(ctx);
					notify(ctx, `Auto keepRecentTokens ${rest} (salvato).`, "info");
					return;
				}
				notify(ctx, "Uso: /autocompact keeprecent-auto <on|off>", "warning");
				return;
			}

			if (arg === "keeprecent") {
				const value = Number.parseInt(rest, 10);
				if (!Number.isFinite(value) || value < 1000) {
					notify(ctx, "Uso: /autocompact keeprecent <token> (min 1000)", "warning");
					return;
				}
				const written = writeKeepRecentToSettings(value);
				notify(
					ctx,
					written
						? `keepRecentTokens impostato a ${value.toLocaleString("en-US")} in settings.json (attivo dalla prossima sessione).`
						: "Nessuna scrittura necessaria (valore già uguale o settings.json non scrivibile).",
					"info",
				);
				return;
			}

			if (arg === "" || arg === "status" || arg === "s") {
				const usage = ctx.getContextUsage();
				const current =
					usage && usage.percent !== null
						? `${usage.percent.toFixed(1)}% of ${usage.contextWindow.toLocaleString("en-US")} tokens`
						: "unknown (no usage sample yet)";
				const memories = listMemoryFiles().length;
				const keepRecent = getKeepRecentFromSettings();
				const model = ctx.model;
				const desired = model && model.contextWindow ? computeKeepRecent(model.contextWindow, config) : undefined;
				const limit = model && model.contextWindow ? (config.percent / 100) * model.contextWindow : undefined;
				const blocked = keepRecentBlocksCompaction(ctx);

				notify(
					ctx,
					`Auto-compact: ${config.enabled ? "ON" : "OFF"} at ${config.percent}% of the context window\n` +
						`Context now: ${current}\n` +
						`Context memory: ${config.memory ? "ON" : "OFF"} (${memories} salvate, cap sintesi ${formatTokens(config.memoryMaxTokens)}, ` +
						`letture tool ${formatTokens(config.toolTokenCap)})\n` +
						`keepRecentTokens: ${keepRecent === undefined ? "(assente)" : keepRecent.toLocaleString("en-US")}` +
						`${desired !== undefined ? ` · desiderato ${desired.toLocaleString("en-US")} (auto ${config.keepRecent.auto ? "on" : "off"})` : ""}` +
						`${limit !== undefined ? ` · limite soglia ${Math.floor(limit).toLocaleString("en-US")}` : ""}\n` +
						`${blocked ? "⚠️ loop guard ATTIVA: keepRecentTokens ≥ soglia, auto-compaction sospesa\n" : ""}` +
						`Config: ${CONFIG_PATH}\n` +
						`Usage: /autocompact <percent|on|off|status|memory-on|memory-off|keeprecent-auto on|off|keeprecent <n>>`,
					blocked ? "warning" : "info",
				);
				return;
			}

			if (arg === "on" || arg === "off") {
				config.enabled = arg === "on";
				saveConfig(config);
				notify(ctx, `Auto-compact ${arg === "on" ? "enabled" : "disabled"} (saved).`, "info");
				return;
			}

			const percent = Number.parseFloat(arg);
			if (Number.isFinite(percent)) {
				config.percent = clampPercent(percent);
				config.enabled = true;
				saveConfig(config);
				notify(ctx, `Auto-compact threshold set to ${config.percent}% of the context window (saved).`, "info");
				return;
			}

			notify(ctx, "Usage: /autocompact <percent|on|off|status|memory-on|memory-off|keeprecent-auto on|off|keeprecent <n>>", "warning");
		},
	});
}
