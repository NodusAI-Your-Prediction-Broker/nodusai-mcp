#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          NodusAI MCP Server  v1.0.0                         ║
 * ║  AI-Powered Signals for Prediction Markets                  ║
 * ║  Oracle: Gemini 2.5 Flash · Payment: $1 USDC = 3 queries   ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Stdio transport — for local clients (Claude Desktop, Cursor, Windsurf).
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "nodusai": {
 *         "command": "node",
 *         "args": ["/path/to/nodusai-mcp/src/index.js"],
 *         "env": { "NODUSAI_API_BASE": "https://nodusai.app" }
 *       }
 *     }
 *   }
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

// ── Server init ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "nodusai-oracle", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "nodus_pricing",
    description:
      "View NodusAI oracle pricing. $1 USDC = 3 Oracle signal queries on Base. Start here.",
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
        marketUrl: {
          type: "string",
          description: "Full URL of a Polymarket or Kalshi prediction market",
        },
      },
      required: ["marketUrl"],
    },
  },
  {
    name: "nodus_get_signal",
    description:
      "Core tool. Pay $1 USDC → get an Oracle signal for a Polymarket or Kalshi market. " +
      "Returns probability, confidence, reasoning, and grounding sources. " +
      "Issues a session token good for 3 queries total (queries 2 and 3 are free).",
    inputSchema: {
      type: "object",
      properties: {
        marketUrl: {
          type: "string",
          description: "Full URL of the Polymarket or Kalshi market to query",
        },
        xPaymentHeader: {
          type: "string",
          description: "Base64-encoded EIP-3009 $1 USDC TransferWithAuthorization signed by your Base wallet",
        },
        walletAddress: {
          type: "string",
          description: "Your Base wallet address",
        },
        agentName: {
          type: "string",
          description: "(Optional) Name for your agent in the NodusAI registry",
        },
      },
      required: ["marketUrl", "xPaymentHeader", "walletAddress"],
    },
  },
  {
    name: "nodus_query_with_session",
    description:
      "Query the Oracle using an existing session token — no extra payment needed. " +
      "Each $1 USDC payment includes 3 queries total. Use this for queries 2 and 3.",
    inputSchema: {
      type: "object",
      properties: {
        marketUrl: {
          type: "string",
          description: "Full URL of the Polymarket or Kalshi market to query",
        },
        sessionToken: {
          type: "string",
          description: "Session token returned by nodus_get_signal",
        },
        walletAddress: {
          type: "string",
          description: "(Optional) Your Base wallet address",
        },
      },
      required: ["marketUrl", "sessionToken"],
    },
  },
  {
    name: "nodus_verify_signal",
    description:
      "Retrieve the grounding sources for a past Oracle signal to independently " +
      "verify the web data inputs that shaped the prediction.",
    inputSchema: {
      type: "object",
      properties: {
        queryId: {
          type: "string",
          description: "The queryId returned by nodus_get_signal or nodus_query_with_session",
        },
      },
      required: ["queryId"],
    },
  },
  {
    name: "nodus_query_history",
    description: "Retrieve your recent NodusAI oracle query history.",
    inputSchema: {
      type: "object",
      properties: {
        walletAddress: {
          type: "string",
          description: "Your Base wallet address",
        },
        limit: {
          type: "number",
          description: "Number of recent queries to return (default: 20)",
        },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "nodus_admin_stats",
    description: "[ADMIN] Platform stats: total queries, USDC revenue, breakdown by platform.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nodus_admin_queries",
    description: "[ADMIN] Full query registry dump for auditing.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max records to return (default: 50)" },
      },
    },
  },
  {
    name: "nodus_mock_payment",
    description:
      "[DEV ONLY] Generate a mock $1 USDC X-PAYMENT header for local testing. " +
      "Never use against the production NodusAI server.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Handler map ────────────────────────────────────────────────────────────────
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

// ── MCP Protocol ───────────────────────────────────────────────────────────────
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

// ── Start ──────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = process.env.NODUSAI_MOCK === "true" ? "MOCK" : "LIVE";
  console.error(`🟢 NodusAI MCP Server [${mode}] — $1 USDC = 3 queries · prediction market signals ready`);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
