// ============================================================================
// Period-aware DeepSeek cost tests — locks the off-peak vs peak cost computed
// by the shared rates layer (extensions/deepseek-rates/rates.ts).
//
// The numbers below reproduce the evidence from the bug report:
//   deepseek-v4-pro, in=18467 (cache miss), out=9027, cache_read=77184 (hit)
//     peak     = $0.063519456  (recorded before the fix)
//     off-peak = $0.031759728  (must be recorded after the fix)
// ============================================================================
import {
  DEFAULT_PEAK_WINDOWS,
  deepSeekCost,
  deepSeekRequestCost,
  peakPeriod,
  type ModelRates,
} from "../extensions/deepseek-rates/rates.ts";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

function approx(name: string, got: number, want: number, tol = 1e-6): void {
  ok(name, Math.abs(got - want) <= tol, `(got ${got} want ${want})`);
}

// Real rates (USD per 1M tokens) from the DeepSeek pricing page.
const v4pro: ModelRates = {
  cacheHit: { off: 0.022, peak: 0.044 },
  cacheMiss: { off: 0.66, peak: 1.32 },
  output: { off: 1.98, peak: 3.96 },
};
const flash: ModelRates = {
  cacheHit: { off: 0.003, peak: 0.006 },
  cacheMiss: { off: 0.15, peak: 0.3 },
  output: { off: 0.6, peak: 1.2 },
};

// Evidence request: in=18467 (cache miss), out=9027, cache_read=77184 (hit).
const usage = { input: 18467, output: 9027, cacheRead: 77184 };

console.log("\n=== deepseek-v4-pro period-aware cost (evidence numbers) ===");
{
  const off = deepSeekRequestCost(v4pro, "off", usage);
  const peak = deepSeekRequestCost(v4pro, "peak", usage);
  approx("off-peak total = $0.031759728", off.total, 0.031759728);
  approx("peak total = $0.063519456", peak.total, 0.063519456);
  approx("off-peak is exactly half of peak", off.total, peak.total / 2);
  // budget.db rounds cost_total to 6 decimals → must be 0.031760, not 0.063519.
  ok("off-peak rounds to $0.031760 (not $0.063519)", off.total.toFixed(6) === "0.031760", `(${off.total.toFixed(6)})`);
  ok("peak rounds to $0.063519", peak.total.toFixed(6) === "0.063519", `(${peak.total.toFixed(6)})`);
}

console.log("\n=== deepseek-flash period-aware cost ===");
{
  const off = deepSeekRequestCost(flash, "off", usage);
  const peak = deepSeekRequestCost(flash, "peak", usage);
  approx("flash off-peak total = $0.008417802", off.total, 0.008417802);
  approx("flash peak total = $0.016835604", peak.total, 0.016835604);
  approx("flash off-peak is exactly half of peak", off.total, peak.total / 2);
}

console.log("\n=== per-1M cost shape (registry override source) ===");
{
  const off = deepSeekCost(v4pro, "off");
  const peak = deepSeekCost(v4pro, "peak");
  ok("v4-pro off input=0.66", off.input === 0.66, `(${off.input})`);
  ok("v4-pro off output=1.98", off.output === 1.98, `(${off.output})`);
  ok("v4-pro off cacheRead=0.022", off.cacheRead === 0.022, `(${off.cacheRead})`);
  ok("v4-pro peak input=1.32", peak.input === 1.32, `(${peak.input})`);
  ok("v4-pro peak output=3.96", peak.output === 3.96, `(${peak.output})`);
  ok("v4-pro peak cacheRead=0.044", peak.cacheRead === 0.044, `(${peak.cacheRead})`);

  const foff = deepSeekCost(flash, "off");
  const fpeak = deepSeekCost(flash, "peak");
  ok("flash off input=0.15", foff.input === 0.15, `(${foff.input})`);
  ok("flash peak input=0.3", fpeak.input === 0.3, `(${fpeak.input})`);
}

console.log("\n=== peak period (weekdays-only schedule) ===");
{
  ok("Wed 16:26 UTC is off-peak", peakPeriod(new Date("2026-09-23T16:26:00Z"), DEFAULT_PEAK_WINDOWS, true) === "off");
  ok("Wed 02:00 UTC is peak", peakPeriod(new Date("2026-09-23T02:00:00Z"), DEFAULT_PEAK_WINDOWS, true) === "peak");
  ok("Wed 07:30 UTC is peak", peakPeriod(new Date("2026-09-23T07:30:00Z"), DEFAULT_PEAK_WINDOWS, true) === "peak");
  ok("Sat 02:00 UTC is off-peak (weekend)", peakPeriod(new Date("2026-09-26T02:00:00Z"), DEFAULT_PEAK_WINDOWS, true) === "off");
  ok("Mon 07:30 UTC is peak", peakPeriod(new Date("2026-09-28T07:30:00Z"), DEFAULT_PEAK_WINDOWS, true) === "peak");
  ok("Wed 01:00 UTC is peak (inclusive start)", peakPeriod(new Date("2026-09-23T01:00:00Z"), DEFAULT_PEAK_WINDOWS, true) === "peak");
  ok("Wed 04:00 UTC is off-peak (exclusive end)", peakPeriod(new Date("2026-09-23T04:00:00Z"), DEFAULT_PEAK_WINDOWS, true) === "off");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
