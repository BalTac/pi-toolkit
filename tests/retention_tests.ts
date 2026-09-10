// ============================================================================
// Harness indipendente per la retention di auto-compact-percent.ts
// (verifica il modulo estratto dal sorgente reale + le correzioni del supervisore)
//
// NOTA: la entry PIU' RECENTE non viene mai ruotata (regola isProtected) -> i
// casi con N memorie se ne aspettano N-1 ruotabili.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-10T12:00:00Z");
let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, extra = ""): void {
	if (cond) { pass++; console.log(`  PASS  ${name}`); }
	else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
function eq(name: string, got: unknown, want: unknown): void {
	ok(name, JSON.stringify(got) === JSON.stringify(want), `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const BASE = mkdtempSync(`${tmpdir()}\\ret-test-`);
function freshDir(): string { return mkdtempSync(`${BASE}\\d-`); }
function makeEntry(dir: string, id: string, opts: { project?: string; ageDays?: number; size?: number; recallDaysAgo?: number | null } = {}): void {
	const size = opts.size ?? 1000;
	const ageDays = opts.ageDays ?? 0;
	const created = new Date(NOW - ageDays * DAY).toISOString();
	writeFileSync(`${dir}\\${id}.memory.md`, `# Context memory ${id}\n`, "utf8");
	writeFileSync(`${dir}\\${id}.archive.jsonl`, "x".repeat(size), "utf8");
	registerMemory(dir, id, { created, project: opts.project ?? "P", bytes: size, archive: `${id}.archive.jsonl` });
	if (opts.recallDaysAgo !== undefined && opts.recallDaysAgo !== null) recordRecall(dir, id, NOW - opts.recallDaysAgo * DAY);
}
const CFG = (over: Partial<RetentionConfig> = {}): RetentionConfig => ({
	enabled: true,
	budgetMB: 0.00286102294921875, // 3000 byte
	rotateAfterDays: 30,
	deleteAfterDays: 90,
	protectProjectDays: 14,
	compress: true,
	...over,
});
const gzCount = (dir: string): number => readdirSync(dir).filter((f) => f.endsWith(".gz")).length;
const rawCount = (dir: string): number => readdirSync(dir).filter((f) => f.endsWith(".archive.jsonl")).length;
const mdCount = (dir: string): number => readdirSync(dir).filter((f) => f.endsWith(".memory.md")).length;

console.log("\n=== 1) registrazione + richiamo ===");
{
	const dir = freshDir();
	makeEntry(dir, "a", { project: "P" });
	eq("entry registrata, status active", readRetention(dir).entries["a"].status, "active");
	eq("recalls iniziali", readRetention(dir).entries["a"].recalls, 0);
	recordRecall(dir, "a", NOW);
	recordRecall(dir, "a", NOW + 1000);
	eq("recalls dopo 2 richiami", readRetention(dir).entries["a"].recalls, 2);
	eq("lastRecall aggiornato", readRetention(dir).entries["a"].lastRecall, new Date(NOW + 1000).toISOString());
	recordRecall(dir, "inesistente", NOW);
	ok("recordRecall su id sconosciuto non rompe", true);
}

console.log("\n=== 2) [FIX A] budget efficace con UN SOLO progetto (tutti protetti dal progetto) ===");
{
	const dir = freshDir();
	for (const [i, id] of ["e1", "e2", "e3", "e4", "e5"].entries()) makeEntry(dir, id, { project: "P", ageDays: 100 - i * 10 });
	const r = sweepRetention(dir, CFG(), { now: NOW, currentProject: "P" });
	eq("ruotate esattamente 2 (fino al budget)", r.rotated.length, 2);
	eq("le più vecchie ruotate per prime", r.rotated, ["e1", "e2"]);
	eq("la più recente mai ruotata", readRetention(dir).entries["e5"].status, "active");
	ok("sotto budget dopo lo sweep", r.totalBytesAfter <= 3000, `(${r.totalBytesAfter})`);
	ok("gz scritti per le ruotate", gzCount(dir) === 2, `(gz=${gzCount(dir)})`);
}

console.log("\n=== 3) gzip in rotazione + memoria sempre preservata ===");
{
	const dir = freshDir();
	for (let i = 0; i < 5; i++) makeEntry(dir, `e${i + 1}`, { project: "ALTRO", ageDays: 50 - i }); // e1 più vecchio, e5 più recente
	sweepRetention(dir, CFG({ budgetMB: 0, rotateAfterDays: 30 }), { now: NOW, currentProject: "P" });
	eq("4 .gz creati (la più recente è protetta)", gzCount(dir), 4);
	eq("1 archivio grezzo resta (il più recente)", rawCount(dir), 1);
	eq("5 .memory.md sempre presenti", mdCount(dir), 5);
	eq("e1 (più vecchia) ruotata", readRetention(dir).entries["e1"].status, "rotated");
	eq("e5 (più recente) attiva", readRetention(dir).entries["e5"].status, "active");
	ok("rotatedAt valorizzato", !!readRetention(dir).entries["e1"].rotatedAt);
}

console.log("\n=== 4) [FIX C] la finestra di cancellazione parte dalla ROTAZIONE ===");
{
	// vecchissima (200 gg) ma ruotata ADESSO: NON deve essere eliminata
	const dir = freshDir();
	makeEntry(dir, "vecchia", { project: "ALTRO", ageDays: 200 });
	makeEntry(dir, "recente", { project: "P", ageDays: 1 }); // più recente -> protetta
	const r = sweepRetention(dir, CFG({ budgetMB: 0, rotateAfterDays: 30, deleteAfterDays: 90 }), { now: NOW, currentProject: "P" });
	eq("ruotata", r.rotated, ["vecchia"]);
	eq("NON eliminata (rotatedAt=ora)", r.deleted, []);
	eq("status rotated", readRetention(dir).entries["vecchia"].status, "rotated");
	ok("il .gz esiste ancora", existsSync(`${dir}\\vecchia.archive.jsonl.gz`));
	ok("la .memory.md resta", existsSync(`${dir}\\vecchia.memory.md`));

	// stessa entry ma ruotata 100 giorni fa -> eliminata
	const dir2 = freshDir();
	makeEntry(dir2, "ruotata-da-tempo", { project: "ALTRO", ageDays: 200 });
	makeEntry(dir2, "recente", { project: "P", ageDays: 1 });
	const idx2 = readRetention(dir2);
	idx2.entries["ruotata-da-tempo"].status = "rotated";
	idx2.entries["ruotata-da-tempo"].archive = "ruotata-da-tempo.archive.jsonl.gz";
	idx2.entries["ruotata-da-tempo"].rotatedAt = new Date(NOW - 100 * DAY).toISOString();
	writeFileSync(`${dir2}\\ruotata-da-tempo.archive.jsonl.gz`, "gz", "utf8");
	unlinkSync(`${dir2}\\ruotata-da-tempo.archive.jsonl`);
	writeRetention(dir2, idx2);
	const r2 = sweepRetention(dir2, CFG({ budgetMB: 0, rotateAfterDays: 30, deleteAfterDays: 90 }), { now: NOW, currentProject: "P" });
	eq("eliminata dopo la finestra di rotazione", r2.deleted, ["ruotata-da-tempo"]);
	eq("status deleted", readRetention(dir2).entries["ruotata-da-tempo"].status, "deleted");
	ok("la .memory.md resta anche dopo l'eliminazione", existsSync(`${dir2}\\ruotata-da-tempo.memory.md`));
}

console.log("\n=== 5) protezione: progetto corrente e richiami recenti ===");
{
	const dir = freshDir();
	makeEntry(dir, "vecchia-altro", { project: "ALTRO", ageDays: 60 });
	makeEntry(dir, "altro-richiamata", { project: "ALTRO2", ageDays: 40, recallDaysAgo: 2 });
	makeEntry(dir, "progetto-corrente", { project: "P", ageDays: 20 });
	const r = sweepRetention(dir, CFG({ budgetMB: 0, rotateAfterDays: 30 }), { now: NOW, currentProject: "P" });
	eq("ruotata solo quella vecchia e non richiamata", r.rotated, ["vecchia-altro"]);
	ok("richiamata di recente protetta", r.protectedIds.includes("altro-richiamata"));
	ok("progetto corrente protetto (sotto budget)", r.protectedIds.includes("progetto-corrente"));
}

console.log("\n=== 6) dryRun non modifica nulla ===");
{
	const dir = freshDir();
	for (let i = 0; i < 5; i++) makeEntry(dir, `e${i + 1}`, { project: "P", ageDays: 100 - i });
	const before = readdirSync(dir).sort();
	const idxBefore = JSON.stringify(readRetention(dir));
	const r = sweepRetention(dir, CFG(), { now: NOW, currentProject: "P", dryRun: true });
	eq("dryRun riporta cosa farebbe", r.rotated.length, 2);
	eq("nessun file creato/rimosso", readdirSync(dir).sort(), before);
	eq("indice immutato", JSON.stringify(readRetention(dir)), idxBefore);
}

console.log("\n=== 7) compress:false elimina l'archivio senza .gz ===");
{
	const dir = freshDir();
	for (let i = 0; i < 3; i++) makeEntry(dir, `e${i + 1}`, { project: "ALTRO", ageDays: 50 - i });
	sweepRetention(dir, CFG({ budgetMB: 0, rotateAfterDays: 30, compress: false }), { now: NOW, currentProject: "P" });
	eq("nessun .gz creato", gzCount(dir), 0);
	eq("2 archivi grezzi rimossi (il più recente resta)", rawCount(dir), 1);
	eq("memorie intatte", mdCount(dir), 3);
	eq("archivio della ruotata azzerato", readRetention(dir).entries["e1"].archive, null);
}

console.log("\n=== 8) retentionSummary (bilancio) ===");
{
	const dir = freshDir();
	makeEntry(dir, "e1", { project: "P" });
	recordRecall(dir, "e1", NOW);
	const s = retentionSummary(dir);
	ok("riporta le attive", s.indexOf("attive 1") >= 0, s);
	ok("riporta il top richiamate", s.indexOf("e1 (1)") >= 0, s);
	ok("riporta i byte reali su disco", s.indexOf("archivi ") >= 0, s);
}

console.log(`\n=== RISULTATO: ${pass} PASSED, ${fail} FAILED ===`);
rmSync(BASE, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
