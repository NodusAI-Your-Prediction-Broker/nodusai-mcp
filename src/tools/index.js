/**
 * NodusAI MCP — Tool Handlers
 *
 * Payment model: $1 USDC = 3 Oracle signal queries (Base, Ethereum, Avalanche). That's it.
 * No tiers, no packages, no subscriptions.
 */

import {
  registerAgent,
  getAgentByWallet,
  createSession,
  validateSession,
  incrementSessionQueryCount,
  logQuery,
  getStats,
  getQueryHistory,
  getAllQueries,
} from "../db/registry.js";

import {
  validateMarketUrl,
  detectPlatform,
  fetchSignalWithPayment,
  fetchSignalWithSession,
  validateSignalSchema,
  mockOracleSignal,
} from "../oracle/adapter.js";

import {
  PRICING,
  buildPaymentRequirements,
  validatePaymentAuthorization,
  mockPaymentHeader,
} from "../payment/x402.js";

const USE_MOCK_ORACLE = process.env.NODUSAI_MOCK === "true" ||
  !process.env.NODUSAI_API_BASE;

const ok  = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const err = (msg)  => ({ content: [{ type: "text", text: `❌ ${msg}` }], isError: true });
const pay = (data) => ({ content: [{ type: "text", text: JSON.stringify({ _status: 402, ...data }, null, 2) }] });

// ── 1. nodus_pricing ───────────────────────────────────────────────────────────
export async function nodusPricing() {
  return ok({
    message:  "NodusAI Oracle — Pricing",
    pricing:  PRICING,
    payment: {
      amount:          "$1.00 USDC",
      queriesIncluded: 3,
      pricePerQuery:   "$0.33 USDC",
      network:         "Base, Ethereum, Avalanche (any EVM)",
      token:           "USDC",
      protocol:        "x402 / EIP-3009 TransferWithAuthorization (any EVM)",
    },
    howItWorks: [
      "1. Call nodus_get_payment_requirements to see what to pay",
      "2. Sign $1 USDC TransferWithAuthorization with your Base wallet",
      "3. Call nodus_get_signal with your signed xPaymentHeader",
      "4. Receive Oracle signal + session token good for 3 queries total",
      "5. Use nodus_query_with_session for your remaining 2 queries (free)",
      "6. Need more? Pay another $1 for 3 more queries",
    ],
    note: "NodusAI is non-custodial. Payments go directly on Base — NodusAI never holds USDC.",
  });
}

// ── 2. nodus_get_payment_requirements ─────────────────────────────────────────
export async function nodusGetPaymentRequirements({ marketUrl }) {
  const validation = validateMarketUrl(marketUrl);
  if (!validation.valid) return err(validation.reason);

  const requirements = buildPaymentRequirements();

  return pay({
    message: "Payment required to query the NodusAI Oracle",
    marketUrl,
    platform: validation.platform,
    requirements,
    instructions: [
      "Sign a USDC TransferWithAuthorization (EIP-3009) for $1.00 using your Base wallet",
      "Encode the signed payload as Base64",
      "Call nodus_get_signal with marketUrl + xPaymentHeader",
    ],
  });
}

// ── 3. nodus_get_signal ────────────────────────────────────────────────────────
export async function nodusGetSignal({ marketUrl, xPaymentHeader, walletAddress, agentName }) {
  const urlCheck = validateMarketUrl(marketUrl);
  if (!urlCheck.valid)  return err(urlCheck.reason);
  if (!xPaymentHeader)  return err("xPaymentHeader is required. Call nodus_get_payment_requirements first.");
  if (!walletAddress)   return err("walletAddress is required (your Base wallet address).");

  // Validate $1 USDC payment
  const paymentCheck = validatePaymentAuthorization(xPaymentHeader);
  if (!paymentCheck.valid) return err(`Payment invalid: ${paymentCheck.reason}`);

  // Register agent (idempotent by wallet address)
  const agent   = registerAgent({ name: agentName || "unnamed-agent", walletAddress });
  const platform = detectPlatform(marketUrl);

  // Call Oracle
  let signal, success, errorMessage;
  try {
    signal  = USE_MOCK_ORACLE ? mockOracleSignal(marketUrl) : (await fetchSignalWithPayment(marketUrl, xPaymentHeader)).signal;
    success = true;
  } catch (e) {
    success      = false;
    errorMessage = e.message;
  }

  if (success && signal) {
    const check = validateSignalSchema(signal);
    if (!check.valid) { success = false; errorMessage = check.reason; }
  }

  // Create session: $1 paid → 3 queries available
  const session = createSession({
    agentId:     agent.id,
    usdcPaid:    PRICING.usdc,
    queriesTotal: PRICING.queries,
    txReference: paymentCheck.txReference,
  });

  // Log to NodusAI registry
  const entry = logQuery({
    agentId:      agent.id,
    agentName:    agent.name,
    marketUrl,
    platform,
    sessionToken: session.token,
    paymentMethod: "x402",
    usdcCost:     success ? PRICING.usdc : 0,
    txReference:  paymentCheck.txReference,
    signal,
    success,
    errorMessage,
  });

  if (!success) return err(errorMessage || "Oracle query failed");

  // First query used — 2 remaining in session
  incrementSessionQueryCount(session.token);

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
    session: {
      token:             session.token,
      queriesTotal:      PRICING.queries,       // 3
      queriesUsed:       1,
      queriesRemaining:  PRICING.queries - 1,   // 2
      expiresAt:         session.expiresAt,
      note:              `2 queries remaining. Use nodus_query_with_session — no extra payment needed.`,
    },
    billing: {
      usdcCharged:     PRICING.usdc,
      queriesIncluded: PRICING.queries,
      network:         "Base",
      txReference:     paymentCheck.txReference,
    },
  });
}

// ── 4. nodus_query_with_session ────────────────────────────────────────────────
export async function nodusQueryWithSession({ marketUrl, sessionToken, walletAddress }) {
  const urlCheck = validateMarketUrl(marketUrl);
  if (!urlCheck.valid) return err(urlCheck.reason);
  if (!sessionToken)   return err("sessionToken is required. Call nodus_get_signal first (costs $1 USDC = 3 queries).");

  const sessionCheck = validateSession(sessionToken);
  if (!sessionCheck.valid) {
    return pay({
      message: `Session invalid: ${sessionCheck.reason}`,
      action:  "Pay $1 USDC to get a new session with 3 queries.",
    });
  }

  // Check queries remaining
  const used      = sessionCheck.session.queryCount;
  const remaining = PRICING.queries - used;
  if (remaining <= 0) {
    return pay({
      message: "All 3 queries in this session have been used.",
      action:  "Pay $1 USDC for a new session with 3 fresh queries.",
      queriesUsed:      used,
      queriesRemaining: 0,
    });
  }

  const platform = detectPlatform(marketUrl);
  let signal, success, errorMessage;

  try {
    signal  = USE_MOCK_ORACLE ? mockOracleSignal(marketUrl) : (await fetchSignalWithSession(marketUrl, sessionToken)).signal;
    success = !!signal;
  } catch (e) {
    success      = false;
    errorMessage = e.message;
  }

  if (success) {
    incrementSessionQueryCount(sessionToken);
    const agent = walletAddress ? registerAgent({ name: "agent", walletAddress }) : { id: sessionCheck.session.agentId, name: "agent" };
    const entry = logQuery({
      agentId:      sessionCheck.session.agentId,
      agentName:    agent.name,
      marketUrl,
      platform,
      sessionToken,
      paymentMethod: "session",
      usdcCost:     0,
      txReference:  null,
      signal,
      success:      true,
    });

    const newUsed      = used + 1;
    const newRemaining = PRICING.queries - newUsed;

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
      session: {
        token:            sessionToken,
        queriesTotal:     PRICING.queries,
        queriesUsed:      newUsed,
        queriesRemaining: newRemaining,
        expiresAt:        sessionCheck.session.expiresAt,
        note:             newRemaining > 0
          ? `${newRemaining} quer${newRemaining === 1 ? "y" : "ies"} remaining in this session.`
          : "Session complete. Pay $1 USDC for 3 more queries.",
      },
    });
  }

  return err(errorMessage || "Oracle query failed");
}

// ── 5. nodus_verify_signal ─────────────────────────────────────────────────────
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
    timestamp:         entry.timestamp,
    signal: {
      market_name:       entry.signal.market_name,
      predicted_outcome: entry.signal.predicted_outcome,
      probability:       entry.signal.probability,
      confidence_score:  entry.signal.confidence_score,
      key_reasoning:     entry.signal.key_reasoning,
    },
    grounding_sources: entry.signal.grounding_sources,
    note:              "Verify these sources independently to audit the Oracle's reasoning.",
  });
}

// ── 6. nodus_query_history ─────────────────────────────────────────────────────
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
      predictedOutcome: q.signal?.predicted_outcome || null,
      probability:      q.signal?.probability ?? null,
      confidence:       q.signal?.confidence_score || null,
      usdcCost:         q.usdcCost,
      paymentMethod:    q.paymentMethod,
      success:          q.success,
      timestamp:        q.timestamp,
    })),
  });
}

// ── 7. nodus_admin_stats ───────────────────────────────────────────────────────
export async function nodusAdminStats() {
  return ok({ message: "NodusAI Platform — Registry Stats", ...getStats() });
}

// ── 8. nodus_admin_queries ─────────────────────────────────────────────────────
export async function nodusAdminQueries({ limit }) {
  return ok({ message: "NodusAI Query Registry", total: limit || 50, queries: getAllQueries(limit || 50) });
}

// ── 9. nodus_mock_payment ──────────────────────────────────────────────────────
export async function nodusMockPayment() {
  const header = mockPaymentHeader();
  return ok({
    _dev_only:      true,
    message:        "Mock X-PAYMENT header — local dev only",
    xPaymentHeader: header,
    amount_usdc:    PRICING.usdc,
    queries:        PRICING.queries,
    warning:        "This mock will NOT work against the production NodusAI server.",
  });
}
