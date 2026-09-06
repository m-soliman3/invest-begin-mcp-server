#!/usr/bin/env node
/**
 * Post-deploy smoke test and schema guard.
 *
 * Beyond checking the server is up, this asserts every field `src/client.ts`
 * reads is actually present in a live snapshot. The analysis producer lives in
 * a different repository, so nothing at compile time catches a field being
 * renamed there — this does, at deploy time, before traffic shifts.
 *
 *   node scripts/smoke.mjs <mcp-url>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: smoke.mjs <mcp-url>");
  process.exit(1);
}

const EXPECTED_TOOLS = [
  "analyze_symbol",
  "get_strategy_signals",
  "compare_symbols",
  "list_covered_symbols",
  "describe_coverage",
];

/** Fields src/client.ts and src/format.ts depend on. */
const REQUIRED_TOP = [
  "symbol", "timeframe", "ranAt", "marketOpen", "marketStatusReason",
  "candleCount", "changePct", "indicators", "conditions", "verdicts",
  "stance", "score", "rationale", "summary",
];
const REQUIRED_INDICATORS = [
  "price", "ema9", "ema21", "macd", "macdSignal", "macdHistogram",
  "rsi14", "rsi14Previous", "bbUpper", "bbBasis", "bbLower", "percentB",
  "roc14", "vwap30", "atr14", "priorHigh20", "priorLow20", "volume", "volumeAverage",
];
const REQUIRED_CONDITIONS = ["atrPct", "vwapDeviationPct", "relativeVolume"];

const failures = [];
const check = (label, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const client = new Client({ name: "ci-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

console.log(`\n== tools (${url})`);
const names = (await client.listTools()).tools.map((t) => t.name);
for (const tool of EXPECTED_TOOLS) check(`tool present: ${tool}`, names.includes(tool));

console.log("\n== coverage");
const coverage = await client.callTool({ name: "list_covered_symbols", arguments: {} });
check("list_covered_symbols returns without error", !coverage.isError);

// Analyse whichever symbol the runner actually covers, so the guard does not
// depend on a hardcoded watchlist that may legitimately change.
const listed = coverage.content?.[0]?.text ?? "";
const match = listed.match(/^\s{2}(\S+)\s+(\S+)\s/m);
check("coverage lists at least one symbol/timeframe", Boolean(match));

if (match) {
  const [, symbol, timeframe] = match;
  console.log(`\n== schema guard via analyze_symbol ${symbol} ${timeframe}`);
  const result = await client.callTool({
    name: "analyze_symbol",
    arguments: { symbol, timeframe },
  });
  check("analyze_symbol returns without error", !result.isError);

  const raw = result.content?.[1]?.text;
  let snapshot = null;
  try {
    snapshot = JSON.parse(raw ?? "");
  } catch {
    /* reported below */
  }
  check("analyze_symbol returns a JSON payload", snapshot !== null);

  if (snapshot) {
    for (const field of REQUIRED_TOP) check(`snapshot.${field}`, field in snapshot);
    for (const field of REQUIRED_INDICATORS) {
      check(`indicators.${field}`, snapshot.indicators && field in snapshot.indicators);
    }
    for (const field of REQUIRED_CONDITIONS) {
      check(`conditions.${field}`, snapshot.conditions && field in snapshot.conditions);
    }
    check("verdicts is a non-empty array", Array.isArray(snapshot.verdicts) && snapshot.verdicts.length > 0);
    check(
      "verdict entries carry {templateId,name,side,reason}",
      (snapshot.verdicts ?? []).every(
        (v) => "templateId" in v && "name" in v && "side" in v && "reason" in v,
      ),
    );
  }
}

await client.close();

console.log(
  failures.length
    ? `\n${failures.length} check(s) FAILED:\n  - ${failures.join("\n  - ")}\n`
    : "\nall checks passed\n",
);
process.exit(failures.length ? 1 : 0);
