/**
 * NodusAI MCP — HTTP/SSE Transport Server
 *
 * Exposes the NodusAI Oracle as a public MCP endpoint over HTTP.
 * Remote AI agents connect via Server-Sent Events (SSE) —
 * no local install required, just a URL.
 *
 * Pricing: $1 USDC = 3 Oracle signal queries (x402 on Base)
 *
 * Endpoints:
 *   GET  /sse      → MCP SSE stream (agents connect here)
 *   POST /message  → MCP message handler
 *   GET  /health   → health check
 *   GET  /info     → server info
 *
 * Start: node src/server-http.js
 * Env:   PORT, NODUSAI_API_BASE, NODUSAI_MOCK
 */

import express               from "express";
import { Server }            from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  nodusPricing,
  nodusGetPaymentRequirements,
  nodusGetSignal,
  nodusQueryWithSession,
  nodusVerifySignal,
  nodusQueryHistory,
  nodusAdminStats,
  nodusAdminQueries,
  nodusMockPayment,
} from "./tools/index.js";

// ── Tool definitions ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "nodus_pricing",
    description: "View NodusAI oracle pricing. $1 USDC = 3 queries on Base. Start here.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nodus_get_payment_requirements",
    description:
      "Get payment requirements for a Polymarket or Kalshi market. " +
      "Returns what to sign ($1 USDC via EIP-3009) before calling nodus_get_signal.",
    inputSchema: {
      type: "object",
      properties: {
        marketUrl: { type: "string", description: "Full URL of a Polymarket or Kalshi market" },
      },
      required: ["marketUrl"],
    },
  },
  {
    name: "nodus_get_signal",
    description:
      "Core tool. Pay $1 USDC → get an Oracle signal for a Polymarket or Kalshi market. " +
      "Returns probability, confidence, reasoning, grounding sources. " +
      "Issues a session token for 2 more free queries (3 total per $1).",
    inputSchema: {
      type: "object",
      properties: {
        marketUrl:      { type: "string", description: "Full URL of the Polymarket or Kalshi market" },
        xPaymentHeader: { type: "string", description: "Base64-encoded EIP-3009 $1 USDC authorization signed by your Base wallet" },
        walletAddress:  { type: "string", description: "Your Base wallet address" },
        agentName:      { type: "string", description: "(Optional) Name for your agent in the NodusAI registry" },
      },
      required: ["marketUrl", "xPaymentHeader", "walletAddress"],
    },
  },
  {
    name: "nodus_query_with_session",
    description:
      "Query the Oracle using an existing session token — no extra payment. " +
      "Each $1 payment includes 3 queries total. Use this for queries 2 and 3.",
    inputSchema: {
      type: "object",
      properties: {
        marketUrl:     { type: "string", description: "Full URL of the Polymarket or Kalshi market" },
        sessionToken:  { type: "string", description: "Session token from nodus_get_signal" },
        walletAddress: { type: "string", description: "(Optional) Your Base wallet address" },
      },
      required: ["marketUrl", "sessionToken"],
    },
  },
  {
    name: "nodus_verify_signal",
    description: "Retrieve the grounding sources for a past signal to independently verify the Oracle's reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        queryId: { type: "string", description: "queryId returned by nodus_get_signal or nodus_query_with_session" },
      },
      required: ["queryId"],
    },
  },
  {
    name: "nodus_query_history",
    description: "View your recent NodusAI oracle query history.",
    inputSchema: {
      type: "object",
      properties: {
        walletAddress: { type: "string", description: "Your Base wallet address" },
        limit:         { type: "number", description: "Max records to return (default: 20)" },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "nodus_admin_stats",
    description: "[ADMIN] Platform stats: total queries, USDC revenue, usage by platform.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nodus_admin_queries",
    description: "[ADMIN] Full query registry dump.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "nodus_mock_payment",
    description: "[DEV ONLY] Generate a mock $1 USDC X-PAYMENT header for local testing.",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLERS = {
  nodus_pricing:                  nodusPricing,
  nodus_get_payment_requirements: nodusGetPaymentRequirements,
  nodus_get_signal:               nodusGetSignal,
  nodus_query_with_session:       nodusQueryWithSession,
  nodus_verify_signal:            nodusVerifySignal,
  nodus_query_history:            nodusQueryHistory,
  nodus_admin_stats:              nodusAdminStats,
  nodus_admin_queries:            nodusAdminQueries,
  nodus_mock_payment:             nodusMockPayment,
};

// ── MCP Server factory (one per SSE connection) ────────────────────────────────
function createMCPServer() {
  const server = new Server(
    { name: "nodusai-oracle", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) {
      return { content: [{ type: "text", text: `❌ Unknown tool: ${name}` }], isError: true };
    }
    try {
      return await handler(args || {});
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Internal error: ${e.message}` }], isError: true };
    }
  });

  return server;
}

// ── Express app ────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const activeTransports = new Map();

// ── GET /health ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:  "ok",
    service: "nodusai-mcp-server",
    version: "1.0.0",
    pricing: "$1 USDC = 3 queries",
    mode:    process.env.NODUSAI_MOCK === "true" ? "mock" : "live",
    oracle:  process.env.NODUSAI_API_BASE || "https://nodusai.app",
    uptime:  Math.round(process.uptime()),
  });
});

// ── GET /info ──────────────────────────────────────────────────────────────────
app.get("/info", (_req, res) => {
  res.json({
    name:        "NodusAI Oracle MCP Server",
    description: "AI-Powered Signals for Prediction Markets",
    version:     "1.0.0",
    pricing:     "$1 USDC = 3 Oracle signal queries",
    mcp:         { protocol: "MCP over SSE", sse: "/sse", messages: "/message" },
    platforms:   ["Polymarket", "Kalshi"],
    payment:     { protocol: "x402", token: "USDC", network: "Base" },
    tools:       TOOLS.map(t => ({ name: t.name, description: t.description.split(".")[0] })),
  });
});

// ── GET /sse ── agents connect here ───────────────────────────────────────────
app.get("/sse", async (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const transport = new SSEServerTransport("/message", res);
    const server    = createMCPServer();

    activeTransports.set(sessionId, transport);

    req.on("close", () => {
      activeTransports.delete(sessionId);
      console.error(`[NodusAI] Agent disconnected — ${sessionId} (active: ${activeTransports.size})`);
    });

    await server.connect(transport);
    console.error(`[NodusAI] Agent connected — ${sessionId} (active: ${activeTransports.size})`);

  } catch (e) {
    console.error(`[NodusAI] SSE error:`, e.message);
    activeTransports.delete(sessionId);
    if (!res.headersSent) res.status(500).end();
  }
});

// ── POST /message ──────────────────────────────────────────────────────────────
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessionId
    ? activeTransports.get(sessionId)
    : [...activeTransports.values()].at(-1);

  if (!transport) {
    return res.status(400).json({ error: "No active MCP session. Connect to /sse first." });
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (e) {
    console.error("[NodusAI] Message error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── CORS ───────────────────────────────────────────────────────────────────────
app.options(/.*/, (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(204);
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const mode = process.env.NODUSAI_MOCK === "true" ? "MOCK" : "LIVE";
  console.error(`
╔══════════════════════════════════════════════════════════╗
║       NodusAI MCP Server  [HTTP/SSE]  v1.0.0            ║
║  AI-Powered Signals for Prediction Markets              ║
║  Pricing: $1 USDC = 3 queries · Network: Base          ║
╚══════════════════════════════════════════════════════════╝
  Mode:    ${mode} oracle
  SSE:     http://localhost:${PORT}/sse
  Health:  http://localhost:${PORT}/health
  Info:    http://localhost:${PORT}/info
  `);
});
