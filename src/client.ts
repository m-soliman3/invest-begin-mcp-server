import type { Config } from "./config.js";

/** Mirrors AnalysisSnapshot in the Auto-Trader backend. */
export interface TemplateVerdict {
  templateId: string;
  name: string;
  category: string;
  side: "buy" | "sell" | null;
  reason: string;
}

export interface AnalysisSnapshot {
  symbol: string;
  timeframe: string;
  ranAt: string;
  marketOpen: boolean;
  marketStatusReason: string;
  candleCount: number;
  firstCandleAt: string;
  lastCandleAt: string;
  changePct: number;
  indicators: Record<string, number>;
  conditions: Record<string, number | boolean>;
  verdicts: TemplateVerdict[];
  stance: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  score: number;
  rationale: string[];
  summary: string;
}

export class BackendError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "BackendError";
  }
}

/**
 * Read-only client for the Auto-Trader analysis endpoints.
 *
 * It holds ANALYSIS_READ_KEY, which the backend accepts only on GET
 * /v1/analysis*. It deliberately cannot authenticate against the runner or
 * execution routes, so this server has no path to placing an order.
 */
export class AnalysisClient {
  constructor(private readonly config: Config) {}

  private async get<T>(path: string): Promise<T> {
    if (!this.config.backendUrl) {
      throw new BackendError(
        "BACKEND_URL is not set.",
        "Point it at the Auto-Trader Cloud Run service, e.g. https://auto-trader-backend-xxxx.run.app",
      );
    }
    if (!this.config.analysisKey) {
      throw new BackendError(
        "ANALYSIS_READ_KEY is not set.",
        "Set the same value configured as ANALYSIS_READ_KEY on the backend.",
      );
    }

    const response = await fetch(`${this.config.backendUrl}${path}`, {
      headers: { accept: "application/json", "x-analysis-key": this.config.analysisKey },
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }).catch((error: unknown) => {
      throw new BackendError(`Cannot reach the backend: ${(error as Error).message}`);
    });

    if (response.ok) return response.json() as Promise<T>;

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 401) {
      throw new BackendError(
        "Backend rejected the analysis key (HTTP 401).",
        "ANALYSIS_READ_KEY here must match ANALYSIS_READ_KEY on the Cloud Run service.",
      );
    }
    if (response.status === 404) {
      throw new BackendError(
        String(body.error || "No snapshot for that symbol/timeframe."),
        String(body.hint || "Call list_covered_symbols to see what the runner covers."),
      );
    }
    throw new BackendError(`Backend returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  getSnapshot(symbol: string, timeframe: string): Promise<AnalysisSnapshot> {
    const clean = symbol.trim().toUpperCase().replace(/^\$/, "");
    return this.get<AnalysisSnapshot>(
      `/v1/analysis/${encodeURIComponent(clean)}?timeframe=${encodeURIComponent(timeframe)}`,
    );
  }

  async listSnapshots(limit = 200): Promise<AnalysisSnapshot[]> {
    const payload = await this.get<{ count: number; items: AnalysisSnapshot[] }>(
      `/v1/analysis?limit=${limit}`,
    );
    return payload.items ?? [];
  }
}
