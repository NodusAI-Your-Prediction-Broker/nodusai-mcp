/**
 * NodusAI — Oracle Adapter
 *
 * Bridges AI agents to the NodusAI Oracle at nodusai.app.
 *
 * Payment is handled entirely by nodusai.app:
 *   - User connects wallet on nodusai.app
 *   - Pays $1 USDC (Base, Ethereum, or Avalanche)
 *   - Confirms transaction
 *   - Receives a session token good for 3 queries
 *
 * This MCP server just forwards requests to nodusai.app/api/prediction
 * using that session token. No on-chain logic here.
 *
 * Agent flow:
 *   1. Agent visits https://nodusai.app to pay and get a session token
 *   2. Agent calls nodus_get_signal with marketUrl + sessionToken
 *   3. MCP server forwards to nodusai.app/api/prediction
 *   4. Signal returned to agent
 */

const NODUSAI_API_BASE = process.env.NODUSAI_API_BASE || "https://nodusai.app";

// ── Platform detection ─────────────────────────────────────────────────────────
export function detectPlatform(marketUrl) {
  if (!marketUrl) return "unknown";
  const url = marketUrl.toLowerCase();
  if (url.includes("polymarket.com"))   return "polymarket";
  if (url.includes("kalshi.com"))       return "kalshi";
  if (url.includes("manifold.markets")) return "manifold";
  return "unknown";
}

// ── Validate a market URL ──────────────────────────────────────────────────────
export function validateMarketUrl(marketUrl) {
  if (!marketUrl) return { valid: false, reason: "marketUrl is required" };
  try {
    const url = new URL(marketUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return { valid: false, reason: "marketUrl must use http or https" };
    }
    const platform = detectPlatform(marketUrl);
    if (platform === "unknown") {
      return {
        valid:  false,
        reason: "Unrecognized platform. Supported: polymarket.com, kalshi.com.",
      };
    }
    return { valid: true, platform };
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }
}

// ── Fetch signal from NodusAI Oracle ──────────────────────────────────────────
/**
 * Calls nodusai.app/api/prediction with the agent's session token.
 * Session token is obtained by paying $1 USDC on nodusai.app.
 *
 * Optional: pass desiredOutcome to bias the query (e.g. "YES" or "NO")
 */
export async function fetchSignal(marketUrl, sessionToken, desiredOutcome = null) {
  let endpoint = `${NODUSAI_API_BASE}/api/prediction?marketUrl=${encodeURIComponent(marketUrl)}`;
  if (desiredOutcome) {
    endpoint += `&outcome=${encodeURIComponent(desiredOutcome)}`;
  }

  const headers = {
    "Content-Type":  "application/json",
    "X-Session-Token": sessionToken,
  };

  try {
    const response = await fetch(endpoint, { method: "GET", headers });

    if (response.status === 200) {
      const signal = await response.json();
      return { success: true, signal };
    }

    if (response.status === 402) {
      return {
        success:      false,
        needsPayment: true,
        reason:       "Session token invalid or expired. Please visit https://nodusai.app to pay $1 USDC and get a new session token.",
        paymentUrl:   "https://nodusai.app",
      };
    }

    if (response.status === 401) {
      return {
        success: false,
        reason:  "Invalid session token. Please visit https://nodusai.app to get a valid session token.",
        paymentUrl: "https://nodusai.app",
      };
    }

    const body = await response.text();
    return { success: false, reason: `Oracle returned ${response.status}: ${body}` };

  } catch (err) {
    throw new Error(`Failed to reach NodusAI Oracle: ${err.message}`);
  }
}

// ── Validate signal schema ─────────────────────────────────────────────────────
export function validateSignalSchema(signal) {
  const required = [
    "market_name",
    "predicted_outcome",
    "probability",
    "confidence_score",
    "key_reasoning",
    "grounding_sources",
  ];
  for (const field of required) {
    if (signal[field] === undefined || signal[field] === null) {
      return { valid: false, reason: `Signal missing required field: ${field}` };
    }
  }
  if (typeof signal.probability !== "number" || signal.probability < 0 || signal.probability > 1) {
    return { valid: false, reason: "probability must be a number between 0 and 1" };
  }
  if (!["HIGH", "MEDIUM", "LOW"].includes(signal.confidence_score)) {
    return { valid: false, reason: "confidence_score must be HIGH, MEDIUM, or LOW" };
  }
  return { valid: true };
}

// ── Mock signal for dev/testing ────────────────────────────────────────────────
export function mockOracleSignal(marketUrl, desiredOutcome = null) {
  const platform = detectPlatform(marketUrl);
  return {
    market_name:       `[MOCK] Sample ${platform} prediction market`,
    predicted_outcome: desiredOutcome || "YES",
    probability:       0.73,
    confidence_score:  "HIGH",
    key_reasoning:
      "Based on current polling data, recent news coverage, and historical base rates " +
      "for similar events, the predicted outcome appears significantly more likely. " +
      "Multiple grounding sources confirm this trend.",
    grounding_sources: [
      { title: "Reuters: Latest developments", url: "https://reuters.com/example" },
      { title: "Associated Press: Event update", url: "https://apnews.com/example" },
    ],
    _mock: true,
    _note: "Mock signal for development. Set NODUSAI_API_BASE for production.",
  };
}
