/**
 * NodusAI — x402 Payment Protocol Handler
 *
 * One payment model: $1 USDC = 3 Oracle signal queries.
 * No tiers, no subscriptions, no packages.
 *
 * Flow:
 *   1. Agent pays $1 USDC via EIP-3009 TransferWithAuthorization on Base
 *   2. Server validates payment → issues session token with 3 query credits
 *   3. Agent uses session token for up to 3 queries
 *   4. Need more queries? Pay another $1.
 *
 * 🔌 WIRE TO BASE RPC: see validatePaymentAuthorization() below
 */

// ── Pricing ────────────────────────────────────────────────────────────────────
export const PRICING = {
  usdc:          1.00,   // $1 USDC per payment
  queries:       3,      // 3 queries per payment
  pricePerQuery: 0.333,  // ~$0.33 per signal
  token:         "USDC",
  network:       "Base",
  description:   "$1 USDC = 3 Oracle signal queries",
};

// ── Payment requirements (returned on 402) ────────────────────────────────────
export function buildPaymentRequirements() {
  return {
    network:         "base",
    token:           "USDC",
    tokenContract:   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base mainnet
    payTo:           "0xNODUSAI_TREASURY_ADDRESS",                   // 🔌 replace with your wallet
    amount:          PRICING.usdc,
    amountFormatted: "$1.00 USDC",
    queriesIncluded: PRICING.queries,
    pricePerQuery:   "$0.33 USDC",
    scheme:          "EIP-3009 TransferWithAuthorization",
    chain:           "base-mainnet",
    chainId:         8453,
    description:     PRICING.description,
  };
}

// ── Validate EIP-3009 payment header ──────────────────────────────────────────
/**
 * 🔌 WIRE TO BASE RPC:
 * Replace the validation logic below with real on-chain verification:
 *   1. Decode Base64 → EIP-3009 payload
 *   2. Verify signature recovers correct `from` address
 *   3. Verify: tokenContract, payTo, amount >= $1 USDC, deadline valid
 *   4. Submit TransferWithAuthorization to Base via ethers.js / viem
 *   5. Wait for confirmation → return txHash
 */
export function validatePaymentAuthorization(xPaymentHeader) {
  if (!xPaymentHeader) {
    return { valid: false, reason: "Missing X-PAYMENT header. Pay $1 USDC on Base to query the Oracle." };
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString("utf-8"));
  } catch {
    return { valid: false, reason: "Invalid X-PAYMENT header encoding." };
  }

  // Required EIP-3009 fields
  const required = ["from", "to", "value", "validAfter", "validBefore", "nonce", "signature"];
  for (const field of required) {
    if (!decoded[field]) return { valid: false, reason: `Missing EIP-3009 field: ${field}` };
  }

  // Deadline check
  const now = Math.floor(Date.now() / 1000);
  if (now > decoded.validBefore) return { valid: false, reason: "Payment authorization expired." };
  if (now < decoded.validAfter)  return { valid: false, reason: "Payment authorization not yet valid." };

  // Amount check: must be >= $1 USDC (6 decimals)
  const requiredRaw = Math.round(PRICING.usdc * 1_000_000); // 1_000_000
  if (parseInt(decoded.value) < requiredRaw) {
    return {
      valid:  false,
      reason: `Payment too low. Required: $1.00 USDC, received: $${(parseInt(decoded.value) / 1_000_000).toFixed(2)} USDC`,
    };
  }

  // 🔌 WIRE TO BASE RPC: submit on-chain here, return real txHash
  // const txHash = await submitTransferWithAuthorization(decoded);

  return {
    valid:       true,
    from:        decoded.from,
    amountUsdc:  parseInt(decoded.value) / 1_000_000,
    txReference: decoded.txHash || `mock_tx_${Date.now()}`,
  };
}

// ── Mock payment for dev/testing ──────────────────────────────────────────────
export function mockPaymentHeader() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    from:        "0xTestAgent000000000000000000000000000000",
    to:          "0xNODUSAI_TREASURY_ADDRESS",
    value:       "1000000", // $1.00 USDC in raw units
    validAfter:  now - 10,
    validBefore: now + 3600,
    nonce:       `0x${Math.random().toString(16).slice(2).padStart(64, "0")}`,
    signature:   "0xMOCK_SIGNATURE_FOR_DEVELOPMENT",
    txHash:      `0xmock_${Date.now().toString(16)}`,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
