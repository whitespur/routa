/**
 * Session DB Persister — persists ACP sessions to SQLite or Postgres.
 *
 * Kept in core/acp/ so relative require paths to ../db/* are stable
 * in both local-dev and Next.js compiled output.
 */

import { getDatabaseDriver, getPostgresDatabase } from "@/core/db/index";
import { PgAcpSessionStore } from "@/core/db/pg-acp-session-store";
import { SqliteAcpSessionStore } from "@/core/db/sqlite-stores";

export interface SessionPersistData {
  id: string;
  name?: string;
  cwd: string;
  /** Git branch the session is scoped to (optional) */
  branch?: string;
  workspaceId: string;
  routaAgentId: string;
  provider: string;
  role: string;
  modeId?: string;
  model?: string;
  /** Parent session ID for child (CRAFTER/GATE) sessions */
  parentSessionId?: string;
}

export async function persistSessionToDb(data: SessionPersistData): Promise<void> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return;

  const now = new Date();
  const sessionRecord = {
    id: data.id,
    name: data.name,
    cwd: data.cwd,
    branch: data.branch,
    workspaceId: data.workspaceId,
    routaAgentId: data.routaAgentId,
    provider: data.provider,
    role: data.role,
    modeId: data.modeId,
    firstPromptSent: false,
    messageHistory: [] as never[],
    parentSessionId: data.parentSessionId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      const pgStore = new PgAcpSessionStore(db);
      await pgStore.save(sessionRecord);
    } else {
      // sqlite — use eval("require") to avoid bundling in serverless/edge
      // eslint-disable-next-line no-eval
      const dynamicRequire = eval("require") as NodeRequire;
      const { getSqliteDatabase } = dynamicRequire("../db/sqlite");
      const db = getSqliteDatabase();
      const sqliteStore = new SqliteAcpSessionStore(db);
      await sqliteStore.save(sessionRecord);
    }
    console.log(`[SessionDB] Persisted session to ${driver}: ${data.id}`);
  } catch (err) {
    console.error(`[SessionDB] Failed to persist session to ${driver}:`, err);
  }
}

export async function deleteSessionFromDb(sessionId: string): Promise<void> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return;

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      await new PgAcpSessionStore(db).delete(sessionId);
    } else {
      // eslint-disable-next-line no-eval
      const dynamicRequire = eval("require") as NodeRequire;
      const { getSqliteDatabase } = dynamicRequire("../db/sqlite");
      const db = getSqliteDatabase();
      await new SqliteAcpSessionStore(db).delete(sessionId);
    }
  } catch (err) {
    console.error(`[SessionDB] Failed to delete session from ${driver}:`, err);
  }
}

export async function renameSessionInDb(sessionId: string, name: string): Promise<void> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return;

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      await new PgAcpSessionStore(db).rename(sessionId, name);
    } else {
      // eslint-disable-next-line no-eval
      const dynamicRequire = eval("require") as NodeRequire;
      const { getSqliteDatabase } = dynamicRequire("../db/sqlite");
      const db = getSqliteDatabase();
      await new SqliteAcpSessionStore(db).rename(sessionId, name);
    }
  } catch (err) {
    console.error(`[SessionDB] Failed to rename session in ${driver}:`, err);
  }
}

export async function hydrateSessionsFromDb(): Promise<Array<{
  id: string;
  name?: string;
  cwd: string;
  branch?: string;
  workspaceId: string;
  routaAgentId?: string;
  provider?: string;
  role?: string;
  modeId?: string;
  model?: string;
  parentSessionId?: string;
  createdAt: Date | null;
}>> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return [];

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      return await new PgAcpSessionStore(db).list();
    } else {
      // eslint-disable-next-line no-eval
      const dynamicRequire = eval("require") as NodeRequire;
      const { getSqliteDatabase } = dynamicRequire("../db/sqlite");
      const db = getSqliteDatabase();
      return await new SqliteAcpSessionStore(db).list();
    }
  } catch (err) {
    console.error(`[SessionDB] Failed to load sessions from ${driver}:`, err);
    return [];
  }
}

export async function saveHistoryToDb(
  sessionId: string,
  history: import("@/core/acp/http-session-store").SessionUpdateNotification[]
): Promise<void> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return;

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      const pgStore = new PgAcpSessionStore(db);
      const session = await pgStore.get(sessionId);
      if (!session) return;
      const merged = mergeHistory(session.messageHistory ?? [], history);
      await pgStore.save({ ...session, messageHistory: merged, updatedAt: new Date() });
    } else {
      // eslint-disable-next-line no-eval
      const dynamicRequire = eval("require") as NodeRequire;
      const { getSqliteDatabase } = dynamicRequire("../db/sqlite");
      const db = getSqliteDatabase();
      const sqliteStore = new SqliteAcpSessionStore(db);
      const session = await sqliteStore.get(sessionId);
      if (!session) return;
      const merged = mergeHistory(session.messageHistory ?? [], history);
      await sqliteStore.save({ ...session, messageHistory: merged, updatedAt: new Date() });
    }
  } catch (err) {
    console.error(`[SessionDB] Failed to save history to ${driver}:`, err);
  }
}

/**
 * Merge DB history with in-memory history to avoid losing older entries
 * that were trimmed by limitHistorySize.
 *
 * Strategy: if the DB already has more entries than the incoming history,
 * the in-memory store was likely truncated. We keep the DB prefix (older
 * entries) and append only the new tail from the in-memory history.
 */
function mergeHistory(
  dbHistory: unknown[],
  inMemoryHistory: import("@/core/acp/http-session-store").SessionUpdateNotification[]
): import("@/core/acp/http-session-store").SessionUpdateNotification[] {
  if (dbHistory.length === 0) return inMemoryHistory;
  if (inMemoryHistory.length === 0) return dbHistory as import("@/core/acp/http-session-store").SessionUpdateNotification[];

  // Find where the in-memory history overlaps with the DB history.
  // The first entry in inMemoryHistory should exist somewhere in dbHistory.
  // If dbHistory is longer, it means older entries were trimmed from memory.
  const firstInMemory = JSON.stringify(inMemoryHistory[0]);
  let overlapIndex = -1;
  // Search from the end of dbHistory backwards for efficiency
  for (let i = dbHistory.length - 1; i >= 0; i--) {
    if (JSON.stringify(dbHistory[i]) === firstInMemory) {
      overlapIndex = i;
      break;
    }
  }

  if (overlapIndex >= 0) {
    // DB has older entries before the overlap point — keep them
    const prefix = dbHistory.slice(0, overlapIndex) as import("@/core/acp/http-session-store").SessionUpdateNotification[];
    return [...prefix, ...inMemoryHistory];
  }

  // No overlap found — in-memory history is entirely new (or DB was empty/reset).
  // If DB has more entries, keep DB prefix + append in-memory as new tail.
  if (dbHistory.length > inMemoryHistory.length) {
    return [...(dbHistory as import("@/core/acp/http-session-store").SessionUpdateNotification[]), ...inMemoryHistory];
  }

  // Default: in-memory is the authoritative source
  return inMemoryHistory;
}

export async function loadHistoryFromDb(
  sessionId: string
): Promise<import("@/core/acp/http-session-store").SessionUpdateNotification[]> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return [];

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      return (await new PgAcpSessionStore(db).getHistory(sessionId)) as import("@/core/acp/http-session-store").SessionUpdateNotification[];
    } else {
      // eslint-disable-next-line no-eval
      const dynamicRequire = eval("require") as NodeRequire;
      const { getSqliteDatabase } = dynamicRequire("../db/sqlite");
      const db = getSqliteDatabase();
      return (await new SqliteAcpSessionStore(db).getHistory(sessionId)) as import("@/core/acp/http-session-store").SessionUpdateNotification[];
    }
  } catch (err) {
    console.error(`[SessionDB] Failed to load history from ${driver}:`, err);
    return [];
  }
}
