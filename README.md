# Technical Analysis MCP Server

A remote MCP connector for **Claude and ChatGPT**. Users ask *"what do the
indicators say about NVDA?"* and get RSI, EMA crossovers, MACD, Bollinger
Bands, VWAP, breakouts and trend-following readings — plus which of your
strategy templates are currently firing.

It is a **read-only client** of the Auto-Trader backend
(`autotrader-b8851`). All analysis is precomputed by a scheduled runner there,
so this server holds no market-data credentials and, by design, has **no
credential that can place, modify or cancel an order**.

## Architecture

```
Cloud Scheduler  ──POST /v1/run-analysis──▶  Auto-Trader backend (Cloud Run)
  */5 * * * *                                  engine/analysis.ts
                                               reuses buildMarketContext()
                                               + the same conditions as
                                               engine/signals.ts
                                                        │
                                                        ▼
                                          Firestore  marketAnalysis/{SYM}_{tf}
                                                        │
                     ┌──────GET /v1/analysis*───────────┘
                     │      (x-analysis-key, read-only)
                     ▼
        THIS SERVER  ── Streamable HTTP /mcp ──▶  Claude  ·  ChatGPT
```

Because the runner evaluates the **same condition expressions** as the live
trading evaluator, an answer given here never contradicts what a user's bot
would actually do.

## Tools

| Tool | Answers |
|------|---------|
| `analyze_symbol` | "What do the indicators say about NVDA?" — the main tool |
| `get_strategy_signals` | "Which strategies are signalling buy right now?" |
| `compare_symbols` | "Rank my watchlist by technical stance" |
| `list_covered_symbols` | "What can you analyse, and how fresh is it?" |
| `describe_coverage` | Connector wiring and health — call this on any auth error |

Each returns a readable summary plus the full JSON snapshot.

Sample output:

```
BTC/USD (1d): STRONGLY BULLISH — score +0.86, price 64895.737, RSI(14) 54.54

Market: OPEN — Crypto market is 24/7.
TREND
  EMA9 64183.662 vs EMA21 64094.4688 — fast is above
  MACD 69.2412 vs signal 32.34891 (histogram 36.89229)
MOMENTUM
  RSI(14) 54.54 (previous 51.31)   ROC(14) 1.247%
VOLATILITY & LEVELS
  Bollinger 62495.38 / 64391.07 / 66286.76 — %B 0.6331
  ATR(14) 1535.70 (2.366% of price)   20-bar range 62216.21 – 66933.60

STRATEGIES FIRING (3 of 10)
  BUY  EMA Crossover — EMA9 crossed above EMA21
  BUY  MACD Trend Rider — MACD bullish crossover above zero
  BUY  Supertrend Scalper — Bullish trend flip in high volatility
```

## Run locally

```bash
npm install
npm run build
BACKEND_URL=https://... ANALYSIS_READ_KEY=... npm start
curl localhost:8080/health
```

## Deploy

```bash
gcloud run deploy ta-mcp-server \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars BACKEND_URL=https://YOUR_BACKEND_URL,ANALYSIS_READ_KEY=...
```

The endpoint is then `https://YOUR_MCP_URL/mcp`.

### Public endpoint: https://www.invest-begin.com/mcp

`www.invest-begin.com` is Firebase Hosting for `autotrader-b8851`, so the
connector is exposed through a Hosting rewrite rather than the raw Cloud Run
URL. `firebase.json` (prod target only) gains:

```json
{ "source": "/mcp",    "run": { "serviceId": "ta-mcp-server", "region": "europe-west1" } },
{ "source": "/mcp/**", "run": { "serviceId": "ta-mcp-server", "region": "europe-west1" } }
```

These must sit **before** the `"**" -> /index.csr.html` catch-all, or the
Angular SPA swallows `/mcp`.

Order matters: the Cloud Run service has to exist before Hosting will accept a
rewrite pointing at it.

```bash
# 1. Cloud Run service
gcloud run deploy ta-mcp-server --project=autotrader-b8851 --region=europe-west1 \
  --source . --allow-unauthenticated \
  --set-env-vars "BACKEND_URL=...,ANALYSIS_READ_KEY=..."

# 2. Hosting rewrite
firebase login --reauth
firebase deploy --only hosting:prod --project autotrader-b8851
```

`firebase deploy --only hosting:prod` republishes everything in
`dist/auto-trading/browser`, so rebuild the site first if that directory is
stale — otherwise the deploy silently rolls the front end back.

### Connecting Claude

Settings → Connectors → Add custom connector → `https://www.invest-begin.com/mcp`

### Connecting ChatGPT

Settings → Connectors → Add. **ChatGPT requires Developer mode, which OpenAI
limits to Business, Enterprise and Edu plans** (Pro is read/fetch only, Free
excluded). The endpoint must be public HTTPS — which the Hosting rewrite gives
you, with a certificate already in place.

Set `MCP_AUTH_TOKEN` to require `Authorization: Bearer <token>` if you don't
want the endpoint open to anyone who finds the URL.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `BACKEND_URL` | — | Auto-Trader Cloud Run base URL (no trailing slash) |
| `ANALYSIS_READ_KEY` | — | Must match `ANALYSIS_READ_KEY` on the backend |
| `MCP_AUTH_TOKEN` | *(empty)* | Optional bearer gate on `/mcp` |
| `PORT` | `8080` | Listen port |
| `REQUEST_TIMEOUT_MS` | `15000` | Backend request timeout |
| `DEFAULT_TIMEFRAME` | `1h` | Used when a caller omits one |
| `MCP_ENABLE_SSE` | `false` | Set `true` only when serving Cloud Run directly, bypassing Hosting |

## Design notes

**Stateless transport.** Cloud Run may route consecutive requests to different
instances, so the server builds a fresh MCP server and transport per request
(`sessionIdGenerator: undefined`) rather than holding a session in memory.

**JSON replies, not SSE.** Firebase Hosting buffers proxied responses and cuts
them off at 60 seconds, which breaks Server-Sent Events. The transport runs
with `enableJsonResponse: true` so every reply is a single `application/json`
body. Nothing is lost — every tool here is a short request/response with no
server-initiated messages.

**`Cache-Control: no-store`.** Hosting's CDN caches proxied responses by
default. A cached JSON-RPC reply would be served to the wrong request.

**Separate read key.** `ANALYSIS_READ_KEY` is not `RUNNER_API_KEY`. The runner
key can trigger `/v1/run-active-strategies`, which places real orders; this
server must never hold it.

**No user data.** Snapshots live in the top-level `marketAnalysis` collection,
never under `users/{uid}/`, so this connector has no path to
`users/{uid}/exchanges` — which stores broker API keys in plaintext.

## Not investment advice

This reports what configured technical strategies currently signal. It does not
predict prices and must not be presented as investment advice.
