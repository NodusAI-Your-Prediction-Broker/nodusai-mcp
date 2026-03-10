#!/usr/bin/env node
/**
 * NodusAI MCP Server v1.0.0 — Stdio Transport
 *
 * AI agents use this to get prediction market signals from NodusAI Oracle.
 *
 * Payment is handled by nodusai.app:
 *   1. Visit https://nodusai.app
 *   2. Connect wallet (Base, Ethereum, Avalanche)
 *   3. Paste market URL + optional desired outcome
 *   4. Pay $1 USDC → get session token (3 queries)
 *   5. Use session token with nodus_get_signal here
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const server = new Server(
  { name: "nodusai-oracle", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = process.env.NODUSAI_MOCK === "true" ? "MOCK" : "LIVE";
  console.error(`🟢 NodusAI MCP Server [${mode}] — ready. Payment via nodusai.app`);
}

main().catch((e) => { console.error("❌ Fatal:", e); process.exit(1); });
