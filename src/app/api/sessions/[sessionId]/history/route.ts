/**
 * Session History API Route - /api/sessions/[sessionId]/history
 *
 * Returns the message history for a session, used when switching sessions
 * in the UI to restore the chat transcript.
 *
 * Query params:
 * - consolidated=true: Returns consolidated history (agent_message_chunk merged into agent_message)
 *
 * Falls back to DB when in-memory history is empty (serverless cold start).
 */

import { NextRequest, NextResponse } from "next/server";
import { getHttpSessionStore, consolidateMessageHistory } from "@/core/acp/http-session-store";
import { loadHistoryFromDb } from "@/core/acp/session-db-persister";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const consolidated = request.nextUrl.searchParams.get("consolidated") === "true";

  const store = getHttpSessionStore();
  const inMemoryHistory = store.getHistory(sessionId);

  // Always check DB — it may contain older entries that were trimmed from memory
  const dbHistory = await loadHistoryFromDb(sessionId);

  let history: typeof inMemoryHistory;

  if (inMemoryHistory.length === 0 && dbHistory.length > 0) {
    // Cold start: populate in-memory store from DB
    for (const notification of dbHistory) {
      store.pushNotificationToHistory(sessionId, notification);
    }
    history = dbHistory;
  } else if (dbHistory.length > inMemoryHistory.length) {
    // DB has older entries that were trimmed from in-memory store.
    // Find where in-memory starts in DB and prepend the DB prefix.
    const firstInMemory = JSON.stringify(inMemoryHistory[0]);
    let overlapIndex = -1;
    for (let i = dbHistory.length - 1; i >= 0; i--) {
      if (JSON.stringify(dbHistory[i]) === firstInMemory) {
        overlapIndex = i;
        break;
      }
    }
    if (overlapIndex > 0) {
      history = [...dbHistory.slice(0, overlapIndex), ...inMemoryHistory];
    } else {
      history = inMemoryHistory;
    }
  } else {
    history = inMemoryHistory;
  }

  const result = consolidated ? consolidateMessageHistory(history) : history;

  return NextResponse.json(
    { history: result },
    { headers: { "Cache-Control": "no-store" } }
  );
}

