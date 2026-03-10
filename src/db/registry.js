/**
 * NodusAI — Query Registry (Database Layer)
 *
 * Stores every signal request made through the MCP server:
 *   - Which agent queried, which market URL, when
 *   - The full Oracle response (signal JSON)
 *   - Payment metadata (session token, USDC amount, tx reference)
 *   - Success / error status
 *
 * Storage: JSON file (dev). Replace loadDB / saveDB with your
 * PostgreSQL / Supabase / MongoDB driver for production.
 *
 * Schema mirrors NodusAI's structured output format exactly.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data");
const DB_PATH  = join(DATA_DIR, "nodusai-registry.json");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_DB = {
  sessions: {},      // sessionToken → { agentId, createdAt, queryCount, expiresAt }
  queries:  [],      // full query log — the core registry
  agents:   {},      // agentId → { name, walletAddress, createdAt }
  stats: {
    total_queries:       0,
    successful_queries:  0,
    failed_queries:      0,
    total_usdc_paid:     0,
  },
};

function loadDB() {
  if (!existsSync(DB_PATH)) {
    writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
    return structuredClone(DEFAULT_DB);
  }
  return JSON.parse(readFileSync(DB_PATH, "utf-8"));
}

function saveDB(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── Agents ─────────────────────────────────────────────────────────────────────
export function registerAgent({ name, walletAddress }) {
  const db = loadDB();
  // Idempotent: same wallet address = same agent record
  const existing = Object.values(db.agents).find(a => a.walletAddress === walletAddress);
  if (existing) return existing;
  const agent = {
    id: randomUUID(),
    name,
    walletAddress,
    createdAt: new Date().toISOString(),
  };
  db.agents[agent.id] = agent;
  saveDB(db);
  return agent;
}

export function getAgentByWallet(walletAddress) {
  const db = loadDB();
  return Object.values(db.agents).find(a => a.walletAddress === walletAddress) || null;
}

// ── Sessions ───────────────────────────────────────────────────────────────────
export function createSession({ agentId, usdcPaid, queriesTotal, txReference }) {
  const db = loadDB();
  const token = `nodus_sess_${randomUUID().replace(/-/g, "")}`;
  const session = {
    token,
    agentId,
    usdcPaid,
    txReference,
    queryCount: 0,
    queriesTotal: queriesTotal || 3,
    createdAt:  new Date().toISOString(),
    // Sessions valid for 24 hours — aligns with NodusAI session-based access model
    expiresAt:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  db.sessions[token] = session;
  saveDB(db);
  return session;
}

export function validateSession(token) {
  const db = loadDB();
  const session = db.sessions[token];
  if (!session) return { valid: false, reason: "Session token not found" };
  if (new Date() > new Date(session.expiresAt)) return { valid: false, reason: "Session expired" };
  return { valid: true, session };
}

export function incrementSessionQueryCount(token) {
  const db = loadDB();
  if (db.sessions[token]) {
    db.sessions[token].queryCount++;
    saveDB(db);
  }
}

// ── Query Registry (core) ──────────────────────────────────────────────────────
/**
 * logQuery — writes one entry to the NodusAI query registry.
 *
 * Each entry captures the full lifecycle of a signal request:
 *   input  → marketUrl, agentId, sessionToken
 *   output → the full NodusAI signal JSON (or error)
 *   billing → usdcCost, paymentMethod, txReference
 */
export function logQuery({
  agentId,
  agentName,
  marketUrl,
  platform,         // "polymarket" | "kalshi" | "unknown"
  sessionToken,
  paymentMethod,    // "session" | "direct_x402"
  usdcCost,
  txReference,
  signal,           // full Oracle JSON output
  success,
  errorMessage,
}) {
  const db = loadDB();

  const entry = {
    id:            randomUUID(),
    agentId,
    agentName,
    marketUrl,
    platform,
    sessionToken,
    paymentMethod,
    usdcCost,
    txReference:   txReference || null,
    // Signal — the NodusAI structured output (null on failure)
    signal: success ? {
      market_name:      signal.market_name,
      predicted_outcome: signal.predicted_outcome,
      probability:       signal.probability,
      confidence_score:  signal.confidence_score,
      key_reasoning:     signal.key_reasoning,
      grounding_sources: signal.grounding_sources || [],
    } : null,
    success,
    errorMessage:  success ? null : errorMessage,
    timestamp:     new Date().toISOString(),
  };

  db.queries.push(entry);
  db.stats.total_queries++;
  if (success) {
    db.stats.successful_queries++;
    db.stats.total_usdc_paid = parseFloat(
      (db.stats.total_usdc_paid + usdcCost).toFixed(6)
    );
  } else {
    db.stats.failed_queries++;
  }

  saveDB(db);
  return entry;
}

// ── Analytics ──────────────────────────────────────────────────────────────────
export function getStats() {
  const db = loadDB();
  const queries = db.queries;

  const byPlatform = queries.reduce((acc, q) => {
    acc[q.platform] = (acc[q.platform] || 0) + 1;
    return acc;
  }, {});

  const byConfidence = queries
    .filter(q => q.success && q.signal)
    .reduce((acc, q) => {
      const c = q.signal.confidence_score;
      acc[c] = (acc[c] || 0) + 1;
      return acc;
    }, {});

  const recentQueries = queries.slice(-10).reverse().map(q => ({
    id:        q.id,
    marketUrl: q.marketUrl,
    platform:  q.platform,
    outcome:   q.signal?.predicted_outcome || "N/A",
    probability: q.signal?.probability ?? null,
    confidence:  q.signal?.confidence_score || null,
    success:   q.success,
    timestamp: q.timestamp,
  }));

  return {
    ...db.stats,
    byPlatform,
    byConfidence,
    recentQueries,
    registeredAgents: Object.keys(db.agents).length,
    activeSessions:   Object.values(db.sessions).filter(
      s => new Date() < new Date(s.expiresAt)
    ).length,
  };
}

export function getQueryHistory(agentId, limit = 50) {
  const db = loadDB();
  return db.queries
    .filter(q => q.agentId === agentId)
    .slice(-limit)
    .reverse();
}

export function getAllQueries(limit = 100) {
  const db = loadDB();
  return db.queries.slice(-limit).reverse();
}
