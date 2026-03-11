/**
 * NodusAI — Example JS Agent
 *
 * Demonstrates how to query the NodusAI Oracle via MCP.
 *
 * Prerequisites:
 *   1. Visit https://nodusai.app
 *   2. Connect wallet & pay $1 USDC to get a session token
 *   3. Set SESSION_TOKEN env var below
 */

import { Client }            from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL      = process.env.MCP_URL      || "https://nodusai-mcp-production.up.railway.app/sse";
const SESSION_TOKEN = process.env.SESSION_TOKEN || "your-session-token-from-nodusai.app";
const MARKET_URL   = process.env.MARKET_URL   || "https://polymarket.com/event/will-btc-hit-100k";

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
}

async function main() {
  console.log("🤖 NodusAI Agent starting...");
  console.log(`   MCP Server: ${MCP_URL}`);
  console.log(`   Market:     ${MARKET_URL}\n`);

  const client = new Client({ name: "example-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(MCP_URL)));
  console.log("✅ Connected to NodusAI MCP Server\n");

  // Step 1: Check pricing
  const pricing = await callTool(client, "nodus_pricing", {});
  console.log("💰 Pricing:", pricing.pricing.cost);
  console.log("   Get a session token at:", pricing.paymentUrl, "\n");

  // Step 2: Get Oracle signal
  console.log("🔮 Querying Oracle...");
  const result = await callTool(client, "nodus_get_signal", {
    marketUrl:      MARKET_URL,
    sessionToken:   SESSION_TOKEN,
    desiredOutcome: "YES",
    agentName:      "example-agent",
  });

  if (result.signal) {
    console.log("\n📊 Oracle Signal:");
    console.log(`   Market:     ${result.signal.market_name}`);
    console.log(`   Outcome:    ${result.signal.predicted_outcome}`);
    console.log(`   Probability: ${(result.signal.probability * 100).toFixed(1)}%`);
    console.log(`   Confidence: ${result.signal.confidence_score}`);
    console.log(`\n   Reasoning: ${result.signal.key_reasoning.slice(0, 120)}...`);
    console.log(`\n   Sources:`);
    result.signal.grounding_sources.forEach(s => console.log(`     - ${s.title}`));

    // Step 3: Verify signal
    const verified = await callTool(client, "nodus_verify_signal", { queryId: result.queryId });
    console.log(`\n✅ Signal verified: ${verified.verified}`);
  } else {
    console.log("❌ No signal:", result.message || result);
    console.log("   Visit https://nodusai.app to get a session token");
  }

  process.exit(0);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
