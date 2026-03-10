/**
 * NodusAI — Oracle Adapter
 *
 * Wraps the NodusAI /api/prediction endpoint.
 * Handles the full x402 payment handshake:
 *   GET /api/prediction?marketUrl=...
 *   → 402 with X-Payment-Required header
 *   → resubmit with X-PAYMENT + X-Session-Token
 *   → 200 with signal JSON
 *
 * The Oracle uses Gemini 2.5 Flash with Google Search grounding.
 * Output always conforms to NodusAI's structured signal schema.
 *
 * 🔌 Set NODUSAI_API_BASE in your environment to point at the live server.
 *    Default: https://nodusai.app (production)
 */

const NODUSAI_API_BASE = process.env.NODUSAI_API_BASE || "https://nodusai.app";

// ── Platform detection ─────────────────────────────────────────────────────────
export function detectPlatform(marketUrl) {
  if (!marketUrl) return "unknown";
  const url = marketUrl.toLowerCase();
  if (url.includes("polymarket.com"))  return "polymarket";
  if (url.includes("kalshi.com"))      return "kalshi";
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
        valid: false,
        reason: "Unrecognized platform. Supported: polymarket.com, kalshi.com. " +
                "Pass any valid market URL from these platforms.",
      };
    }
    return { valid: true, platform };
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }
}

// ── Fetch payment requirements (step 1 of x402) ───────────────────────────────
export async function fetchPaymentRequirements(marketUrl) {
  const endpoint = `${NODUSAI_API_BASE}/api/prediction?marketUrl=${encodeURIComponent(marketUrl)}`;

  try {
    const response = await fetch(endpoint, { method: "GET" });

    if (response.status === 402) {
      const raw = response.headers.get("X-Payment-Required");
      if (!raw) throw new Error("Server returned 402 but missing X-Payment-Required header");
      const requirements = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
      return { status: 402, requirements };
    }

    if (response.status === 200) {
      // No payment needed (e.g. valid session already provided via other means)
      const signal = await response.json();
      return { status: 200, signal };
    }

    throw new Error(`Unexpected status ${response.status} from NodusAI API`);
  } catch (err) {
    throw new Error(`Failed to reach NodusAI oracle: ${err.message}`);
  }
}

// ── Submit payment and get signal (step 2 of x402) ────────────────────────────
export async function fetchSignalWithPayment(marketUrl, xPaymentHeader, sessionToken = null) {
  const endpoint = `${NODUSAI_API_BASE}/api/prediction?marketUrl=${encodeURIComponent(marketUrl)}`;

  const headers = {
    "Content-Type": "application/json",
    "X-PAYMENT": xPaymentHeader,
  };
  if (sessionToken) {
    headers["X-Session-Token"] = sessionToken;
  }

  try {
    const response = await fetch(endpoint, { method: "GET", headers });

    if (response.status === 200) {
      const signal = await response.json();
      // Extract session token from response headers if server issued a new one
      const newSessionToken = response.headers.get("X-Session-Token") || sessionToken;
      return { success: true, signal, sessionToken: newSessionToken };
    }

    if (response.status === 402) {
      return { success: false, reason: "Payment was not accepted by NodusAI server" };
    }

    const body = await response.text();
    return { success: false, reason: `Oracle returned ${response.status}: ${body}` };

  } catch (err) {
    throw new Error(`Oracle request failed: ${err.message}`);
  }
}

// ── Use existing session token (no new payment needed) ────────────────────────
export async function fetchSignalWithSession(marketUrl, sessionToken) {
  const endpoint = `${NODUSAI_API_BASE}/api/prediction?marketUrl=${encodeURIComponent(marketUrl)}`;

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { "X-Session-Token": sessionToken },
    });

    if (response.status === 200) {
      const signal = await response.json();
      return { success: true, signal };
    }

    if (response.status === 402) {
      return {
        success: false,
        reason: "Session expired or invalid. Please pay for a new session.",
        needsPayment: true,
      };
    }

    const body = await response.text();
    return { success: false, reason: `Oracle returned ${response.status}: ${body}` };

  } catch (err) {
    throw new Error(`Oracle request failed: ${err.message}`);
  }
}

// ── Validate signal schema (NodusAI structured output) ────────────────────────
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
    return { valid: false, reason: "Signal probability must be a number between 0 and 1" };
  }
  if (!["HIGH", "MEDIUM", "LOW"].includes(signal.confidence_score)) {
    return { valid: false, reason: "Signal confidence_score must be HIGH, MEDIUM, or LOW" };
  }
  return { valid: true };
}

// ── Mock oracle response (for local dev / testing) ────────────────────────────
export function mockOracleSignal(marketUrl) {
  const platform = detectPlatform(marketUrl);
  return {
    market_name:       `[MOCK] Sample ${platform} prediction market`,
    predicted_outcome: "YES",
    probability:       0.73,
    confidence_score:  "HIGH",
    key_reasoning:
      "Based on current polling data, recent news coverage, and historical base rates " +
      "for similar events, the YES outcome appears significantly more likely. " +
      "Multiple grounding sources confirm this trend.",
    grounding_sources: [
      { title: "Reuters: Latest developments", url: "https://reuters.com/example" },
      { title: "Associated Press: Event update", url: "https://apnews.com/example" },
    ],
    _mock: true,
    _note: "This is a mock signal for development. Wire NODUSAI_API_BASE to production.",
  };
}
