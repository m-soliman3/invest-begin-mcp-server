export interface Config {
  /** Base URL of the Auto-Trader backend on Cloud Run. */
  backendUrl: string;
  /** Read-only key (ANALYSIS_READ_KEY on the backend). Cannot place orders. */
  analysisKey: string;
  /** Optional bearer token gating this MCP server's own HTTP endpoint. */
  mcpAuthToken: string;
  port: number;
  timeoutMs: number;
  defaultTimeframe: string;
  /** Plain JSON replies instead of SSE streams. Required behind a CDN. */
  enableJsonResponse: boolean;
}

export function loadConfig(): Config {
  return {
    backendUrl: (process.env.BACKEND_URL || "").replace(/\/$/, ""),
    analysisKey: process.env.ANALYSIS_READ_KEY || "",
    mcpAuthToken: process.env.MCP_AUTH_TOKEN || "",
    port: Number.parseInt(process.env.PORT || "8080", 10),
    timeoutMs: Number.parseInt(process.env.REQUEST_TIMEOUT_MS || "15000", 10),
    defaultTimeframe: process.env.DEFAULT_TIMEFRAME || "1h",
    // Firebase Hosting buffers responses and cuts them at 60s, which breaks
    // SSE. Every tool here is a short request/response with no server-
    // initiated messages, so JSON replies lose nothing. Opt back into SSE
    // with MCP_ENABLE_SSE=true when serving Cloud Run directly.
    enableJsonResponse: process.env.MCP_ENABLE_SSE !== "true",
  };
}
