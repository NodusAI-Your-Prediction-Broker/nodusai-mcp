/**
 * NodusAI — Agent & Query Registry
 * Simple JSON file store. Replace with PostgreSQL/MongoDB for production.
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "../../data/nodusai-registry.json");

function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      saveDB({ agents: {}, queries: [] });
    }
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch {
    return { agents: {}, queries: [] };
  }
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── Agents ─────────────────────────────────────────────────────────────────────
export function registerAgent({ name, walletAddress }) {
  const db  = loadDB();
  const key = walletAddress.toLowerCase();
  if (!db.agents[key]) {
    db.agents[key] = {
      id:            uuidv4(),
      name,
      walletAddress: key,
      createdAt:     new Date().toISOString(),
      totalQueries:  0,
    };
  } else {
    db.agents[key].name = name || db.agents[key].name;
  }
  saveDB(db);
  return db.agents[key];
}

export function getAgentByWallet(walletAddress) {
  const db = loadDB();
  return db.agents[walletAddress.toLowerCase()] || null;
}

// ── Queries ────────────────────────────────────────────────────────────────────
export function logQuery({
  agentId,
  agentName,
  marketUrl,
  platform,
  sessionToken,
  desiredOutcome,
  signal,
  success,
  errorMessage,
}) {
  const db    = loadDB();
  const entry = {
    id:             uuidv4(),
    agentId:        agentId || "anonymous",
    agentName:      agentName || "anonymous",
    marketUrl,
    platform,
    sessionToken:   sessionToken ? sessionToken.slice(0, 8) + "..." : null,
    desiredOutcome: desiredOutcome || null,
    signal:         success ? signal : null,
    success,
    errorMessage:   success ? null : errorMessage,
    timestamp:      new Date().toISOString(),
  };
  db.queries.push(entry);

  // Update agent query count
  if (agentId && agentId !== "anonymous") {
    for (const agent of Object.values(db.agents)) {
      if (agent.id === agentId) {
        agent.totalQueries = (agent.totalQueries || 0) + 1;
        break;
      }
    }
  }
  saveDB(db);
  return entry;
}

export function getQueryHistory(agentId, limit = 20) {
  const db = loadDB();
  return db.queries
    .filter(q => q.agentId === agentId)
    .slice(-limit)
    .reverse();
}

export function getAllQueries(limit = 50) {
  const db = loadDB();
  return db.queries.slice(-limit).reverse();
}

export function getStats() {
  const db       = loadDB();
  const queries  = db.queries;
  const byPlatform = {};
  for (const q of queries) {
    byPlatform[q.platform] = (byPlatform[q.platform] || 0) + 1;
  }
  return {
    total_queries:   queries.length,
    total_agents:    Object.keys(db.agents).length,
    success_rate:    queries.length
      ? Math.round((queries.filter(q => q.success).length / queries.length) * 100) + "%"
      : "N/A",
    by_platform:     byPlatform,
    last_query:      queries.at(-1)?.timestamp || null,
  };
}
