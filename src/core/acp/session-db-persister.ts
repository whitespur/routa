/**
 * Session DB Persister — persists ACP sessions to DB + local JSONL files.
 *
 * In local/desktop environments, sessions are also written to JSONL files
 * under ~/.routa/projects/{folder-slug}/sessions/ for file-level persistence.
 *
 * Kept in core/acp/ so relative require paths to ../db/* are stable
 * in both local-dev and Next.js compiled output.
 */

import { getDatabaseDriver, getPostgresDatabase } from "@/core/db/index";
import { PgAcpSessionStore } from "@/core/db/pg-acp-session-store";
import { SqliteAcpSessionStore } from "@/core/db/sqlite-stores";
import { LocalSessionProvider } from "@/core/storage/local-session-provider";
import type { SessionRecord, SessionJsonlEntry } from "@/core/storage/types";

function isServerless(): boolean {
  return !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/** Get a LocalSessionProvider for the given cwd (local environments only). */
function getLocalProvider(cwd: string): LocalSessionProvider | null {
  if (isServerless()) return null;
  return new LocalSessionProvider(cwd);
}

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

  // 1. Persist to DB (Postgres or SQLite)
  if (driver !== "memory") {
    try {
      if (driver === "postgres") {
        const db = getPostgresDatabase();
        await new PgAcpSessionStore(db).save(sessionRecord);
      } else {
        // eslint-disable-next-line no-eval
        const dynamicRequire = eval("require") as NodeRequire;
        const { getSqliteDatabase } = dynamicRequire("../db/sqlite");
        const db = getSqliteDatabase();
        await new SqliteAcpSessionStore(db).save(sessionRecord);
      }
      console.log(`[SessionDB] Persisted session to ${driver}: ${data.id}`);
    } catch (err) {
      console.error(`[SessionDB] Failed to persist session to ${driver}:`, err);
    }
  }

  // 2. Also persist to local JSONL file (non-serverless only)
  const local = getLocalProvider(data.cwd);
  if (local) {
    try {
      const record: SessionRecord = {
        id: data.id,
        name: data.name,
        cwd: data.cwd,
        branch: data.branch,
        workspaceId: data.workspaceId,
        routaAgentId: data.routaAgentId,
        provider: data.provider,
        role: data.role,
        modeId: data.modeId,
        model: data.model,
        parentSessionId: data.parentSessionId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await local.save(record);
    } catch (err) {
      console.error(`[SessionDB] Failed to persist session to JSONL:`, err);
    }
  }
}

export async function deleteSessionFromDb(sessionId: string): Promise<void> {
  const driver = getDatabaseDriver();

  // Delete from DB
  if (driver !== "memory") {
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

  // Also delete local JSONL file — we need cwd to locate the file,
  // but we don't have it here. The JSONL file will be orphaned but harmless.
  // A future cleanup task can handle this.
}

export async function renameSessionInDb(sessionId: string, name: string): Promise<void> {
  const driver = getDatabaseDriver();

  if (driver !== "memory") {
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

  // Note: JSONL rename requires reading the session first to get cwd.
  // The metadata will be updated on next save() call.
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

  // 1. Save to DB
  if (driver !== "memory") {
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

  // 2. Also append to local JSONL (non-serverless only)
  // We need the session's cwd to locate the JSONL file.
  // Try to get it from the in-memory store.
  if (!isServerless()) {
    try {
      const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
      const store = getHttpSessionStore();
      const session = store.getSession(sessionId);
      if (session?.cwd) {
        const local = new LocalSessionProvider(session.cwd);
        // Append each history entry as a JSONL message
        for (const entry of history) {
          const jsonlEntry: SessionJsonlEntry = {
            uuid: (entry as Record<string, unknown>).uuid as string ?? sessionId,
            type: (entry as Record<string, unknown>).type as string ?? "notification",
            message: entry,
            sessionId,
            timestamp: new Date().toISOString(),
          };
          await local.appendMessage(sessionId, jsonlEntry);
        }
      }
    } catch {
      // Non-fatal — JSONL write is best-effort
    }
  }
}

/**
 * Merge DB history with in-memory history to avoid losing older entries
 * that were trimmed by limitHistorySize.
 */
function mergeHistory(
  dbHistory: unknown[],
  inMemoryHistory: import("@/core/acp/http-session-store").SessionUpdateNotification[]
): import("@/core/acp/http-session-store").SessionUpdateNotification[] {
  if (dbHistory.length === 0) return inMemoryHistory;
  if (inMemoryHistory.length === 0) return dbHistory as import("@/core/acp/http-session-store").SessionUpdateNotification[];

  const firstInMemory = JSON.stringify(inMemoryHistory[0]);
  let overlapIndex = -1;
  for (let i = dbHistory.length - 1; i >= 0; i--) {
    if (JSON.stringify(dbHistory[i]) === firstInMemory) {
      overlapIndex = i;
      break;
    }
  }

  if (overlapIndex >= 0) {
    const prefix = dbHistory.slice(0, overlapIndex) as import("@/core/acp/http-session-store").SessionUpdateNotification[];
    return [...prefix, ...inMemoryHistory];
  }

  if (dbHistory.length > inMemoryHistory.length) {
    return [...(dbHistory as import("@/core/acp/http-session-store").SessionUpdateNotification[]), ...inMemoryHistory];
  }

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
