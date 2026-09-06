#!/usr/bin/env node
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const app = express();
app.use(express.json({ limit: "1mb" }));

// ChatGPT and Claude call this from the browser/their servers; the session
// header must be exposed or the client cannot follow a streamed response.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "invest-begin-technical-analysis-mcp",
    backendConfigured: Boolean(config.backendUrl && config.analysisKey),
    at: new Date().toISOString(),
  });
});

/** Optional shared-secret gate, for deployments that are not behind OAuth. */
function authorized(req: Request): boolean {
  if (!config.mcpAuthToken) return true;
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") && header.slice(7) === config.mcpAuthToken;
}

/**
 * Stateless Streamable HTTP: a fresh server and transport per request.
 *
 * Cloud Run may route consecutive requests to different instances, so holding
 * a session in memory would break; statelessness keeps every request routable
 * anywhere.
 */
async function handleMcp(req: Request, res: Response): Promise<void> {
  if (!authorized(req)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }

  // Firebase Hosting caches proxied responses by default; a cached JSON-RPC
  // reply would be served to the wrong request.
  res.setHeader("Cache-Control", "no-store");

  const server = createServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: config.enableJsonResponse,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    process.stderr.write(`[mcp] request failed: ${(error as Error).stack}\n`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

app.post("/mcp", handleMcp);
app.get("/mcp", handleMcp);
app.delete("/mcp", handleMcp);

app.listen(config.port, () => {
  process.stderr.write(
    `[mcp] listening on :${config.port}/mcp — backend ${config.backendUrl || "(unset)"}, ` +
      `read key ${config.analysisKey ? "set" : "MISSING"}, ` +
      `auth ${config.mcpAuthToken ? "bearer" : "open"}\n`,
  );
});
