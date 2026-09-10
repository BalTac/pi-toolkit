#!/bin/bash
# ============================================================================
# run_retention_tests.sh — harness per la retention di auto-compact-percent.ts
#
# Estrae il modulo retention (funzioni module-level) dal sorgente REALE
# dell'estensione, lo accoda ai test e lo esegue con node.
# Nessuna duplicazione del codice: se l'estensione cambia, i test seguono.
#
# Uso:  bash run_retention_tests.sh [percorso-estensione]
# ============================================================================
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
EXT="${1:-$DIR/../extensions/auto-compact-percent.ts}"
TMP="${TMPDIR:-/tmp}"
ESB="$HOME/.pi/agent/npm/node_modules/.bin/esbuild"
OUT="$TMP/ret_full"

if [ ! -f "$EXT" ]; then echo "estensione non trovata: $EXT"; exit 1; fi
[ -x "$ESB" ] || { echo "esbuild non trovato in $ESB"; exit 1; }

python - "$EXT" "$DIR/retention_tests.ts" "$OUT.ts" <<'PYEOF'
import io, sys
src, tests_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
lines = io.open(src, encoding="utf-8").read().split("\n")

def find(pred):
    return next(i for i, l in enumerate(lines) if pred(l))

start = find(lambda l: l.startswith("interface RetentionConfig"))
inside, end = False, None
for i in range(start, len(lines)):
    if lines[i].startswith("function sweepRetention("):
        inside = True
    if inside and lines[i] == "}":
        end = i
        break

head = ('import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";\n'
        'import { gzipSync } from "node:zlib";\nimport { join } from "node:path";\nimport { tmpdir } from "node:os";\n')
tests = io.open(tests_path, encoding="utf-8").read()
# scarta l'intestazione del file di test (import duplicati)
tests = tests.split("// ============================================================================", 2)[-1]
io.open(out, "w", encoding="utf-8").write(head + "\n".join(lines[start:end + 1]) + "\n" + tests)
print("estratto modulo retention: righe %d..%d" % (start + 1, end + 1))
PYEOF

"$ESB" "$OUT.ts" --format=cjs --outfile="$OUT.cjs" > /dev/null 2>&1 || { echo "errore di compilazione"; exit 1; }
node "$OUT.cjs"
rm -f "$OUT.ts" "$OUT.cjs"
