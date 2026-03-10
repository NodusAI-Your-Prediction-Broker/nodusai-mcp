/**
 * NodusAI MCP Server v1.0.0 — HTTP/SSE Transport
 *
 * Payment is handled by nodusai.app:
 *   1. Visit https://nodusai.app
 *   2. Connect wallet (Base, Ethereum, Avalanche)
 *   3. Paste market URL + optional desired outcome
 *   4. Pay $1 USDC → get session token (3 queries)
 *   5. Use session token with nodus_get_signal
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
  nodusGetSignal,
  nodusVerifySignal,
  nodusQueryHistory,
  nodusAdminStats,
  nodusAdminQueries,
} from "./tools/index.js";

const TOOLS = [
  {
    name: "nodus_pricing",
    description:
      "View NodusAI pricing and how to get started. " +
      "Pay $1 USDC on nodusai.app → get a session token → use it for 3 Oracle signal queries.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nodus_get_signal",
    description:
      "Get an Oracle signal for a Polymarket or Kalshi prediction market. " +
      "Requires a session token from nodusai.app ($1 USDC = 3 queries). " +
      "Optionally pass a desiredOutcome (YES/NO) to focus the analysis. " +
      "Returns probability, confidence, reasoning, and grounding sources.",
    inputSchema: {
      type: "object",
      properties: {
        marketUrl: {
          type: "string",
          description: "Full URL of the Polymarket or Kalshi market",
        },
        sessionToken: {
          type: "string",
          description: "Session token from nodusai.app (pay $1 USDC to get one)",
        },
        desiredOutcome: {
          type: "string",
          description: "(Optional) Desired outcome to analyze e.g. YES or NO",
        },
        walletAddress: {
          type: "string",
          description: "(Optional) Your wallet address for query history",
        },
        agentName: {
          type: "string",
          description: "(Optional) Name for your agent in the registry",
        },
      },
      required: ["marketUrl", "sessionToken"],
    },
  },
  {
    name: "nodus_verify_signal",
    description: "Retrieve grounding sources for a past signal to verify the Oracle's reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        queryId: { type: "string", description: "queryId from a previous nodus_get_signal call" },
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
        walletAddress: { type: "string", description: "Your wallet address" },
        limit:         { type: "number", description: "Max records (default: 20)" },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "nodus_admin_stats",
    description: "[ADMIN] Platform stats: total queries, breakdown by platform.",
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
];

const HANDLERS = {
  nodus_pricing:       nodusPricing,
  nodus_get_signal:    nodusGetSignal,
  nodus_verify_signal: nodusVerifySignal,
  nodus_query_history: nodusQueryHistory,
  nodus_admin_stats:   nodusAdminStats,
  nodus_admin_queries: nodusAdminQueries,
};

function createMCPServer() {
  const server = new Server(
    { name: "nodusai-oracle", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) return { content: [{ type: "text", text: `❌ Unknown tool: ${name}` }], isError: true };
    try {
      return await handler(args || {});
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Internal error: ${e.message}` }], isError: true };
    }
  });
  return server;
}

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
const activeTransports = new Map();

app.get("/health", (_req, res) => {
  res.json({
    status:     "ok",
    service:    "nodusai-mcp-server",
    version:    "1.0.0",
    pricing:    "$1 USDC = 3 queries",
    networks:   ["Base", "Ethereum", "Avalanche"],
    paymentUrl: "https://nodusai.app",
    mode:       process.env.NODUSAI_MOCK === "true" ? "mock" : "live",
    oracle:     process.env.NODUSAI_API_BASE || "https://nodusai.app",
    uptime:     Math.round(process.uptime()),
  });
});

app.get("/info", (_req, res) => {
  res.json({
    name:        "NodusAI Oracle MCP Server",
    description: "AI-Powered Signals for Prediction Markets",
    version:     "1.0.0",
    pricing:     "$1 USDC = 3 Oracle signal queries",
    paymentUrl:  "https://nodusai.app",
    networks:    ["Base", "Ethereum", "Avalanche"],
    platforms:   ["Polymarket", "Kalshi"],
    mcp:         { protocol: "MCP over SSE", sse: "/sse", messages: "/message" },
    tools:       TOOLS.map(t => ({ name: t.name, description: t.description.split(".")[0] })),
  });
});

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
      console.error(`[NodusAI] Disconnected — ${sessionId} (active: ${activeTransports.size})`);
    });
    await server.connect(transport);
    console.error(`[NodusAI] Connected — ${sessionId} (active: ${activeTransports.size})`);
  } catch (e) {
    console.error(`[NodusAI] SSE error:`, e.message);
    activeTransports.delete(sessionId);
    if (!res.headersSent) res.status(500).end();
  }
});

app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessionId
    ? activeTransports.get(sessionId)
    : [...activeTransports.values()].at(-1);
  if (!transport) return res.status(400).json({ error: "No active MCP session. Connect to /sse first." });
  try {
    await transport.handlePostMessage(req, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.options(/.*/, (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(204);
});

app.listen(PORT, () => {
  const mode = process.env.NODUSAI_MOCK === "true" ? "MOCK" : "LIVE";
  console.error(`
╔══════════════════════════════════════════════════════════╗
║       NodusAI MCP Server  [HTTP/SSE]  v1.0.0            ║
║  AI-Powered Signals for Prediction Markets              ║
║  Pay $1 USDC at nodusai.app → 3 queries                ║
╚══════════════════════════════════════════════════════════╝
  Mode:    ${mode} oracle
  SSE:     http://localhost:${PORT}/sse
  Health:  http://localhost:${PORT}/health
  Info:    http://localhost:${PORT}/info
  `);
});
