import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AnalysisClient, BackendError, type AnalysisSnapshot } from "./client.js";
import type { Config } from "./config.js";
import { headline, json, summarize } from "./format.js";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

function text(...parts: string[]): CallToolResult {
  return { content: parts.map((part) => ({ type: "text" as const, text: part })) };
}

function failure(error: unknown): CallToolResult {
  const message =
    error instanceof BackendError
      ? error.hint
        ? `${error.message}\n${error.hint}`
        : error.message
      : `Unexpected failure: ${(error as Error).message}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function createServer(config: Config, client = new AnalysisClient(config)): McpServer {
  const server = new McpServer(
    { name: "invest-begin-technical-analysis", version: "0.1.0" },
    {
      instructions:
        "Answers technical-analysis questions about stocks and crypto — RSI, " +
        "moving-average crossovers, MACD, Bollinger Bands, VWAP, breakouts and " +
        "trend following. Readings come from an always-on analysis runner that " +
        "evaluates the same strategy templates the user's trading bots use, so " +
        "answers here match what their bots see. Everything is read-only: this " +
        "server cannot place, modify or cancel an order. Report what the " +
        "indicators say; never present it as a price forecast or as investment " +
        "advice, and always mention when the market is closed or the snapshot " +
        "is stale.",
    },
  );

  const timeframeArg = z
    .enum(TIMEFRAMES)
    .default(config.defaultTimeframe as (typeof TIMEFRAMES)[number])
    .describe("Chart timeframe. Coverage depends on the runner's configuration.");

  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "analyze_symbol",
    {
      title: "Analyze a symbol",
      description:
        "Full technical read on one symbol: trend (EMA9/EMA21, MACD), momentum " +
        "(RSI, ROC), volatility and levels (Bollinger, ATR, 20-bar range, VWAP), " +
        "volume, which strategy templates are firing, and an overall stance. " +
        "Start here for any 'what do the indicators say about X' question.",
      inputSchema: {
        symbol: z.string().min(1).max(16)
          .describe("Ticker, e.g. AAPL. Crypto pairs use a slash: BTC/USD."),
        timeframe: timeframeArg,
      },
      annotations: readOnly,
    },
    async ({ symbol, timeframe }) => {
      try {
        const snapshot = await client.getSnapshot(symbol, timeframe);
        return text(summarize(snapshot), json(snapshot));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_strategy_signals",
    {
      title: "Strategy signals",
      description:
        "Which strategy templates (EMA Crossover, MACD Trend Rider, RSI " +
        "Reversal, Breakout Momentum, Bollinger Bounce, VWAP Reversion, " +
        "Supertrend, Grid, Scalping, ROC Momentum) are currently signalling, " +
        "and why. Omit `symbol` to sweep everything the runner covers.",
      inputSchema: {
        symbol: z.string().min(1).max(16).optional()
          .describe("Restrict to one symbol. Omit to scan all covered symbols."),
        timeframe: timeframeArg,
        side: z.enum(["all", "buy", "sell"]).default("all")
          .describe("Only return templates signalling this side."),
      },
      annotations: readOnly,
    },
    async ({ symbol, timeframe, side }) => {
      try {
        const snapshots = symbol
          ? [await client.getSnapshot(symbol, timeframe)]
          : (await client.listSnapshots()).filter((s) => s.timeframe === timeframe);

        const rows = snapshots.flatMap((snapshot) =>
          snapshot.verdicts
            .filter((v) => v.side !== null && (side === "all" || v.side === side))
            .map((v) => ({
              symbol: snapshot.symbol,
              timeframe: snapshot.timeframe,
              template: v.name,
              templateId: v.templateId,
              category: v.category,
              side: v.side,
              reason: v.reason,
              stance: snapshot.stance,
              ranAt: snapshot.ranAt,
            })),
        );

        if (rows.length === 0) {
          return text(
            `No strategy template is signalling ${side === "all" ? "" : `${side} `}on ` +
              `${symbol ? symbol.toUpperCase() : `${snapshots.length} covered symbol(s)`} ` +
              `(${timeframe}).`,
          );
        }

        const lines = rows.map(
          (r) => `  ${r.side!.toUpperCase().padEnd(4)} ${r.symbol} ${r.template} — ${r.reason}`,
        );
        return text([`${rows.length} signal(s) on ${timeframe}:`, ...lines].join("\n"), json(rows));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "compare_symbols",
    {
      title: "Compare symbols",
      description:
        "Rank several symbols by their technical stance on the same timeframe, " +
        "most bullish first. Use for watchlist scans and relative strength.",
      inputSchema: {
        symbols: z.array(z.string().min(1).max(16)).min(2).max(15),
        timeframe: timeframeArg,
      },
      annotations: readOnly,
    },
    async ({ symbols, timeframe }) => {
      const settled = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            return { snapshot: await client.getSnapshot(symbol, timeframe), error: null };
          } catch (error) {
            return {
              snapshot: null,
              error: `${symbol.toUpperCase()}: ${(error as Error).message}`,
            };
          }
        }),
      );

      const scored = settled
        .filter((r): r is { snapshot: AnalysisSnapshot; error: null } => r.snapshot !== null)
        .sort((a, b) => b.snapshot.score - a.snapshot.score);
      const failed = settled.filter((r) => r.snapshot === null).map((r) => r.error!);

      if (scored.length === 0) return failure(new BackendError(failed.join("; ")));

      const lines = [
        `Ranked ${scored.length} symbol(s) on ${timeframe}, most bullish first:`,
        ...scored.map((r, i) => `  ${i + 1}. ${headline(r.snapshot)}`),
      ];
      if (failed.length) lines.push("Not available:", ...failed.map((f) => `  - ${f}`));

      return text(
        lines.join("\n"),
        json({
          ranking: scored.map((r) => ({
            symbol: r.snapshot.symbol,
            stance: r.snapshot.stance,
            score: r.snapshot.score,
            rsi14: r.snapshot.indicators.rsi14,
            firing: r.snapshot.verdicts.filter((v) => v.side).length,
            ranAt: r.snapshot.ranAt,
          })),
          errors: failed,
        }),
      );
    },
  );

  server.registerTool(
    "list_covered_symbols",
    {
      title: "Coverage",
      description:
        "List every symbol and timeframe the analysis runner currently covers, " +
        "with each one's stance and how fresh it is. Call this when a symbol " +
        "is not found, to see what is available instead.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const snapshots = await client.listSnapshots();
        if (snapshots.length === 0) {
          return text(
            "The runner has not written any snapshots yet.",
            "Check that the Cloud Scheduler job is triggering POST /v1/run-analysis.",
          );
        }

        const now = Date.now();
        const rows = snapshots
          .map((s) => ({
            symbol: s.symbol,
            timeframe: s.timeframe,
            stance: s.stance,
            score: s.score,
            marketOpen: s.marketOpen,
            ranAt: s.ranAt,
            ageMinutes: Math.round((now - Date.parse(s.ranAt)) / 60_000),
          }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.timeframe.localeCompare(b.timeframe));

        const lines = rows.map(
          (r) =>
            `  ${r.symbol.padEnd(10)} ${r.timeframe.padEnd(4)} ${r.stance.padEnd(12)} ` +
            `${r.ageMinutes}m ago${r.marketOpen ? "" : " (market closed)"}`,
        );
        return text([`${rows.length} covered symbol/timeframe pair(s):`, ...lines].join("\n"), json(rows));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "describe_coverage",
    {
      title: "Connector status",
      description:
        "Report how this connector is wired: which backend it reads, whether " +
        "the read key is configured, and what it can and cannot do. Call this " +
        "first when a tool returns an auth or connectivity error.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      text(
        [
          `Backend: ${config.backendUrl || "(BACKEND_URL not set)"}`,
          `Read key configured: ${config.analysisKey ? "yes" : "no"}`,
          `Default timeframe: ${config.defaultTimeframe}`,
          "",
          "Readings are produced by a scheduled runner that evaluates the same " +
            "strategy templates as the user's trading bots, so this connector " +
            "and their bots agree.",
          "",
          "This connector is read-only. It authenticates with a key the backend " +
            "accepts only on GET /v1/analysis*, and has no credential that can " +
            "place, modify or cancel an order.",
        ].join("\n"),
      ),
  );

  return server;
}
