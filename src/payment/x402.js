/**
 * NodusAI — x402 Payment Protocol Handler
 *
 * One payment model: $1 USDC = 3 Oracle signal queries.
 * Accepted on any EVM network (Base, Ethereum, Avalanche, and more).
 *
 * Flow:
 *   1. Agent pays $1 USDC via EIP-3009 TransferWithAuthorization
 *   2. Server validates payment → issues session token with 3 query credits
 *   3. Agent uses session token for up to 3 queries
 *   4. Need more queries? Pay another $1.
 *
 * 🔌 WIRE TO RPC: see validatePaymentAuthorization() below
 */

// ── Supported EVM networks ─────────────────────────────────────────────────────
export const NETWORKS = {
  base: {
    name:          "Base",
    chainId:       8453,
    usdcContract:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcUrl:        "https://mainnet.base.org",
  },
  ethereum: {
    name:          "Ethereum",
    chainId:       1,
    usdcContract:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpcUrl:        "https://mainnet.infura.io",
  },
  avalanche: {
    name:          "Avalanche",
    chainId:       43114,
    usdcContract:  "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    rpcUrl:        "https://api.avax.network/ext/bc/C/rpc",
  },
};

// ── Pricing ────────────────────────────────────────────────────────────────────
export const PRICING = {
  usdc:          1.00,
  queries:       3,
  pricePerQuery: 0.333,
  token:         "USDC",
  networks:      Object.keys(NETWORKS),
  description:   "$1 USDC = 3 Oracle signal queries (Base, Ethereum, Avalanche)",
};

// ── Payment requirements (returned on 402) ────────────────────────────────────
export function buildPaymentRequirements(network = "base") {
  const net = NETWORKS[network] || NETWORKS.base;
  return {
    token:           "USDC",
    tokenContract:   net.usdcContract,
    payTo:           "0xNODUSAI_TREASURY_ADDRESS", // 🔌 replace with your wallet
    amount:          PRICING.usdc,
    amountFormatted: "$1.00 USDC",
    queriesIncluded: PRICING.queries,
    pricePerQuery:   "$0.33 USDC",
    scheme:          "EIP-3009 TransferWithAuthorization",
    network:         net.name,
    chainId:         net.chainId,
    supportedNetworks: Object.values(NETWORKS).map(n => ({
      name:    n.name,
      chainId: n.chainId,
      usdc:    n.usdcContract,
    })),
    description: PRICING.description,
  };
}

// ── Validate EIP-3009 payment header ──────────────────────────────────────────
/**
 * 🔌 WIRE TO RPC:
 * Replace the validation logic below with real on-chain verification:
 *   1. Decode Base64 → EIP-3009 payload
 *   2. Detect which network based on chainId in payload
 *   3. Verify signature recovers correct `from` address
 *   4. Verify: tokenContract, payTo, amount >= $1 USDC, deadline valid
 *   5. Submit TransferWithAuthorization via ethers.js / viem
 *   6. Wait for confirmation → return txHash
 */
export function validatePaymentAuthorization(xPaymentHeader) {
  if (!xPaymentHeader) {
    return {
      valid:  false,
      reason: "Missing X-PAYMENT header. Pay $1 USDC on Base, Ethereum, or Avalanche to query the Oracle.",
    };
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
  const requiredRaw = Math.round(PRICING.usdc * 1_000_000);
  if (parseInt(decoded.value) < requiredRaw) {
    return {
      valid:  false,
      reason: `Payment too low. Required: $1.00 USDC, received: $${(parseInt(decoded.value) / 1_000_000).toFixed(2)} USDC`,
    };
  }

  // Detect network from chainId if provided
  const network = decoded.chainId
    ? Object.values(NETWORKS).find(n => n.chainId === decoded.chainId)?.name || "Unknown EVM"
    : "Base";

  // 🔌 WIRE TO RPC: submit on-chain here, return real txHash
  // const txHash = await submitTransferWithAuthorization(decoded);

  return {
    valid:       true,
    from:        decoded.from,
    amountUsdc:  parseInt(decoded.value) / 1_000_000,
    network,
    txReference: decoded.txHash || `mock_tx_${Date.now()}`,
  };
}

// ── Mock payment for dev/testing ──────────────────────────────────────────────
export function mockPaymentHeader(network = "base") {
  const net = NETWORKS[network] || NETWORKS.base;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    from:        "0xTestAgent000000000000000000000000000000",
    to:          "0xNODUSAI_TREASURY_ADDRESS",
    value:       "1000000", // $1.00 USDC in raw units
    chainId:     net.chainId,
    validAfter:  now - 10,
    validBefore: now + 3600,
    nonce:       `0x${Math.random().toString(16).slice(2).padStart(64, "0")}`,
    signature:   "0xMOCK_SIGNATURE_FOR_DEVELOPMENT",
    txHash:      `0xmock_${Date.now().toString(16)}`,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
