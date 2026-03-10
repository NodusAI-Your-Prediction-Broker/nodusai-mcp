/**
 * NodusAI MCP — Tool Handlers
 *
 * Payment is handled by nodusai.app — NOT by this MCP server.
 *
 * Agent flow:
 *   1. Visit https://nodusai.app
 *   2. Connect wallet (Base, Ethereum, or Avalanche)
 *   3. Paste market URL + optional desired outcome
 *   4. Pay $1 USDC → confirm transaction
 *   5. Get session token (good for 3 queries)
 *   6. Use session token here with nodus_get_signal
 */

import {
  validateMarketUrl,
  detectPlatform,
  fetchSignal,
  validateSignalSchema,
  mockOracleSignal,
} from "../oracle/adapter.js";

import {
  registerAgent,
  getAgentByWallet,
  logQuery,
  getStats,
  getQueryHistory,
  getAllQueries,
} from "../db/registry.js";

const USE_MOCK = process.env.NODUSAI_MOCK === "true" || !process.env.NODUSAI_API_BASE;

const ok  = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const err = (msg)  => ({ content: [{ type: "text", text: `❌ ${msg}` }], isError: true });

// ── 1. nodus_pricing ───────────────────────────────────────────────────────────
export async function nodusPricing() {
  return ok({
    message: "NodusAI Oracle — Pricing & How to Connect",
    pricing: {
      cost:            "$1 USDC = 3 Oracle signal queries",
      pricePerQuery:   "$0.33 USDC",
      networks:        ["Base", "Ethereum", "Avalanche"],
      token:           "USDC",
    },
    howToGetStarted: [
      "1. Visit https://nodusai.app",
      "2. Connect your wallet (Base, Ethereum, or Avalanche)",
      "3. Paste a Polymarket or Kalshi market URL",
      "4. (Optional) Add your desired outcome",
      "5. Pay $1 USDC and confirm the transaction",
      "6. Copy your session token",
      "7. Use nodus_get_signal here with your session token",
    ],
    sessionDetails: {
      queriesPerPayment: 3,
      validity:          "24 hours",
      note:              "One session token = 3 queries. After 3 queries, visit nodusai.app to pay again.",
    },
    paymentUrl: "https://nodusai.app",
  });
}

// ── 2. nodus_get_signal ────────────────────────────────────────────────────────
export async function nodusGetSignal({ marketUrl, sessionToken, desiredOutcome, walletAddress, agentName }) {
  const urlCheck = validateMarketUrl(marketUrl);
  if (!urlCheck.valid) return err(urlCheck.reason);

  if (!sessionToken) {
    return err(
      "sessionToken is required.\n\n" +
      "To get a session token:\n" +
      "1. Visit https://nodusai.app\n" +
      "2. Connect your wallet\n" +
      "3. Paste the market URL and pay $1 USDC\n" +
      "4. Copy the session token and pass it here."
    );
  }

  const platform = detectPlatform(marketUrl);

  // Register agent if wallet provided
  const agent = walletAddress
    ? registerAgent({ name: agentName || "unnamed-agent", walletAddress })
    : { id: "anonymous", name: agentName || "anonymous" };

  // Call Oracle
  let signal, success, errorMessage, needsPayment = false;
  try {
    if (USE_MOCK) {
      signal  = mockOracleSignal(marketUrl, desiredOutcome);
      success = true;
    } else {
      const result = await fetchSignal(marketUrl, sessionToken, desiredOutcome);
      if (result.needsPayment) {
        return ok({
          _status:    402,
          message:    result.reason,
          paymentUrl: "https://nodusai.app",
          steps: [
            "1. Visit https://nodusai.app",
            "2. Connect your wallet",
            "3. Pay $1 USDC to get a new session token",
            "4. Call nodus_get_signal again with the new token",
          ],
        });
      }
      signal  = result.signal;
      success = result.success;
      if (!success) errorMessage = result.reason;
    }
  } catch (e) {
    success      = false;
    errorMessage = e.message;
  }

  if (success && signal) {
    const check = validateSignalSchema(signal);
    if (!check.valid) { success = false; errorMessage = check.reason; }
  }

  // Log to registry
  const entry = logQuery({
    agentId:      agent.id,
    agentName:    agent.name,
    marketUrl,
    platform,
    sessionToken,
    desiredOutcome: desiredOutcome || null,
    signal,
    success,
    errorMessage,
  });

  if (!success) return err(errorMessage || "Oracle query failed");

  return ok({
    queryId: entry.id,
    signal: {
      market_name:       signal.market_name,
      predicted_outcome: signal.predicted_outcome,
      probability:       signal.probability,
      confidence_score:  signal.confidence_score,
      key_reasoning:     signal.key_reasoning,
      grounding_sources: signal.grounding_sources,
    },
    meta: {
      platform,
      desiredOutcome: desiredOutcome || null,
      queryId:        entry.id,
      timestamp:      entry.timestamp,
    },
  });
}

// ── 3. nodus_verify_signal ─────────────────────────────────────────────────────
export async function nodusVerifySignal({ queryId }) {
  if (!queryId) return err("queryId is required");
  const all   = getAllQueries(1000);
  const entry = all.find(q => q.id === queryId);
  if (!entry) return err(`Query ${queryId} not found`);
  if (!entry.success || !entry.signal) return ok({ queryId, verified: false, reason: "No signal for this query" });

  return ok({
    queryId,
    verified:          true,
    marketUrl:         entry.marketUrl,
    platform:          entry.platform,
    desiredOutcome:    entry.desiredOutcome || null,
    timestamp:         entry.timestamp,
    signal: {
      market_name:       entry.signal.market_name,
      predicted_outcome: entry.signal.predicted_outcome,
      probability:       entry.signal.probability,
      confidence_score:  entry.signal.confidence_score,
      key_reasoning:     entry.signal.key_reasoning,
    },
    grounding_sources: entry.signal.grounding_sources,
    note: "Verify these sources independently to audit the Oracle's reasoning.",
  });
}

// ── 4. nodus_query_history ─────────────────────────────────────────────────────
export async function nodusQueryHistory({ walletAddress, limit }) {
  if (!walletAddress) return err("walletAddress is required");
  const agent = getAgentByWallet(walletAddress);
  if (!agent) return ok({ message: "No queries found for this wallet", queries: [] });

  const history = getQueryHistory(agent.id, limit || 20);
  return ok({
    agentId:       agent.id,
    walletAddress: agent.walletAddress,
    totalReturned: history.length,
    queries: history.map(q => ({
      queryId:          q.id,
      marketUrl:        q.marketUrl,
      platform:         q.platform,
      desiredOutcome:   q.desiredOutcome || null,
      predictedOutcome: q.signal?.predicted_outcome || null,
      probability:      q.signal?.probability ?? null,
      confidence:       q.signal?.confidence_score || null,
      success:          q.success,
      timestamp:        q.timestamp,
    })),
  });
}

// ── 5. nodus_admin_stats ───────────────────────────────────────────────────────
export async function nodusAdminStats() {
  return ok({ message: "NodusAI Platform — Registry Stats", ...getStats() });
}

// ── 6. nodus_admin_queries ─────────────────────────────────────────────────────
export async function nodusAdminQueries({ limit }) {
  return ok({ message: "NodusAI Query Registry", queries: getAllQueries(limit || 50) });
}
