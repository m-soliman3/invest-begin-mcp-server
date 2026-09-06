import type { AnalysisSnapshot, TemplateVerdict } from "./client.js";

const STANCE_LABEL: Record<AnalysisSnapshot["stance"], string> = {
  strong_buy: "STRONGLY BULLISH",
  buy: "BULLISH",
  neutral: "MIXED — no clear edge",
  sell: "BEARISH",
  strong_sell: "STRONGLY BEARISH",
};

export function headline(snapshot: AnalysisSnapshot): string {
  const sign = snapshot.score >= 0 ? "+" : "";
  return (
    `${snapshot.symbol} (${snapshot.timeframe}): ${STANCE_LABEL[snapshot.stance]} ` +
    `— score ${sign}${snapshot.score}, price ${snapshot.indicators.price}, ` +
    `RSI(14) ${snapshot.indicators.rsi14}`
  );
}

function firing(verdicts: TemplateVerdict[]): TemplateVerdict[] {
  return verdicts.filter((v) => v.side !== null);
}

export function summarize(snapshot: AnalysisSnapshot): string {
  const i = snapshot.indicators;
  const fired = firing(snapshot.verdicts);
  const quiet = snapshot.verdicts.filter((v) => v.side === null);

  const lines = [
    headline(snapshot),
    "",
    `Market: ${snapshot.marketOpen ? "OPEN" : "CLOSED"} — ${snapshot.marketStatusReason}`,
    `Analysed: ${snapshot.ranAt} over ${snapshot.candleCount} candles ` +
      `(${snapshot.firstCandleAt} → ${snapshot.lastCandleAt})`,
    `Change across that window: ${snapshot.changePct}% ` +
      `(first close to last, not a daily move)`,
    "",
    "TREND",
    `  EMA9 ${i.ema9} vs EMA21 ${i.ema21} — fast is ${i.ema9! > i.ema21! ? "above" : "below"}`,
    `  MACD ${i.macd} vs signal ${i.macdSignal} (histogram ${i.macdHistogram})`,
    "MOMENTUM",
    `  RSI(14) ${i.rsi14} (previous ${i.rsi14Previous})`,
    `  ROC(14) ${i.roc14}%`,
    "VOLATILITY & LEVELS",
    `  Bollinger ${i.bbLower} / ${i.bbBasis} / ${i.bbUpper} — %B ${i.percentB}`,
    `  ATR(14) ${i.atr14} (${snapshot.conditions.atrPct}% of price)`,
    `  20-bar range ${i.priorLow20} – ${i.priorHigh20}`,
    `  VWAP(30) ${i.vwap30}, price is ${snapshot.conditions.vwapDeviationPct}% away`,
    "VOLUME",
    `  ${i.volume} vs ${i.volumeAverage} average (${snapshot.conditions.relativeVolume}x)`,
    "",
  ];

  if (fired.length) {
    lines.push(`STRATEGIES FIRING (${fired.length} of ${snapshot.verdicts.length})`);
    for (const v of fired) lines.push(`  ${v.side!.toUpperCase()}  ${v.name} — ${v.reason}`);
  } else {
    lines.push(`STRATEGIES FIRING: none of ${snapshot.verdicts.length}`);
  }

  lines.push("", `Quiet templates: ${quiet.map((v) => v.name).join(", ")}`, "", "WHY");
  for (const reason of snapshot.rationale) lines.push(`  - ${reason}`);

  lines.push(
    "",
    "This reports what the configured technical strategies currently signal. " +
      "It is not a price forecast and not investment advice.",
  );
  return lines.join("\n");
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
