use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;

use crate::error::ServerError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_sessions))
        .route("/{session_id}", get(get_session).patch(rename_session).delete(delete_session))
        .route("/{session_id}/history", get(get_session_history))
        .route("/{session_id}/context", get(get_session_context))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSessionsQuery {
    workspace_id: Option<String>,
    parent_session_id: Option<String>,
    limit: Option<usize>,
}

/// GET /api/sessions — List ACP sessions.
/// Compatible with the Next.js frontend's session-panel.tsx and chat-panel.tsx.
///
/// Merges in-memory sessions with persisted sessions from the database.
async fn list_sessions(
    State(state): State<AppState>,
    Query(query): Query<ListSessionsQuery>,
) -> Json<serde_json::Value> {
    // Get in-memory sessions
    let in_memory_sessions = state.acp_manager.list_sessions().await;

    // Get session IDs currently in memory
    let in_memory_ids: std::collections::HashSet<String> =
        in_memory_sessions.iter().map(|s| s.session_id.clone()).collect();

    // Convert in-memory sessions to JSON values
    let mut sessions: Vec<serde_json::Value> = in_memory_sessions
        .into_iter()
        .filter(|s| {
            // Filter by workspace if specified
            if let Some(ref ws) = query.workspace_id {
                if &s.workspace_id != ws {
                    return false;
                }
            }
            // Filter by parentSessionId if specified
            if let Some(ref parent_id) = query.parent_session_id {
                if s.parent_session_id.as_deref() != Some(parent_id.as_str()) {
                    return false;
                }
            }
            true
        })
        .map(|s| serde_json::to_value(&s).unwrap_or_default())
        .collect();

    // Load sessions from database and merge
    if let Ok(db_sessions) = state
        .acp_session_store
        .list(query.workspace_id.as_deref(), query.limit)
        .await
    {
        for db_session in db_sessions {
            if !in_memory_ids.contains(&db_session.id) {
                // Apply parentSessionId filter for DB sessions too
                if let Some(ref parent_id) = query.parent_session_id {
                    if db_session.parent_session_id.as_deref() != Some(parent_id.as_str()) {
                        continue;
                    }
                }
                sessions.push(serde_json::json!({
                    "sessionId": db_session.id,
                    "name": db_session.name,
                    "cwd": db_session.cwd,
                    "workspaceId": db_session.workspace_id,
                    "routaAgentId": db_session.routa_agent_id,
                    "provider": db_session.provider,
                    "role": db_session.role,
                    "modeId": db_session.mode_id,
                    "createdAt": db_session.created_at,
                    "parentSessionId": db_session.parent_session_id,
                }));
            }
        }
    }

    // Sort by createdAt descending (handle both string and integer formats)
    sessions.sort_by(|a, b| {
        let a_time = a
            .get("createdAt")
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()))))
            .unwrap_or(0);
        let b_time = b
            .get("createdAt")
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()))))
            .unwrap_or(0);
        b_time.cmp(&a_time)
    });

    // Limit results if specified
    if let Some(limit) = query.limit {
        sessions.truncate(limit);
    }

    Json(serde_json::json!({ "sessions": sessions }))
}

/// GET /api/sessions/{session_id} — Get session metadata.
///
/// First tries to get session from in-memory AcpManager.
/// Falls back to database if session is not in memory (e.g. after server restart).
async fn get_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, ServerError> {
    // Try in-memory session first
    if let Some(session) = state.acp_manager.get_session(&session_id).await {
        return Ok(Json(serde_json::json!({
            "session": {
                "sessionId": session.session_id,
                "name": session.name,
                "cwd": session.cwd,
                "workspaceId": session.workspace_id,
                "routaAgentId": session.routa_agent_id,
                "provider": session.provider,
                "role": session.role,
                "modeId": session.mode_id,
                "model": session.model,
                "createdAt": session.created_at,
            }
        })));
    }

    // Fall back to database
    let db_session = state
        .acp_session_store
        .get(&session_id)
        .await?
        .ok_or_else(|| ServerError::NotFound("Session not found".to_string()))?;

    Ok(Json(serde_json::json!({
        "session": {
            "sessionId": db_session.id,
            "name": db_session.name,
            "cwd": db_session.cwd,
            "workspaceId": db_session.workspace_id,
            "routaAgentId": db_session.routa_agent_id,
            "provider": db_session.provider,
            "role": db_session.role,
            "modeId": db_session.mode_id,
            "model": null,
            "createdAt": db_session.created_at,
        }
    })))
}

#[derive(Debug, Deserialize)]
struct RenameSessionRequest {
    name: String,
}

/// PATCH /api/sessions/{session_id} — Rename a session.
async fn rename_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<RenameSessionRequest>,
) -> Result<Json<serde_json::Value>, ServerError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ServerError::BadRequest("Invalid name".to_string()));
    }

    // Update in-memory (may be None if session is DB-only after restart)
    let in_memory_found = state
        .acp_manager
        .rename_session(&session_id, name)
        .await
        .is_some();

    // Always persist the rename to the database
    state.acp_session_store.rename(&session_id, name).await?;

    // If neither memory nor DB had the session, return 404
    if !in_memory_found {
        // Verify it exists in DB (rename is idempotent, so check row count via get)
        if state.acp_session_store.get(&session_id).await?.is_none() {
            return Err(ServerError::NotFound("Session not found".to_string()));
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// DELETE /api/sessions/{session_id} — Delete a session.
async fn delete_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, ServerError> {
    // Try to kill in-memory process (may be None if DB-only after restart)
    let in_memory_found = state
        .acp_manager
        .delete_session(&session_id)
        .await
        .is_some();

    // Always delete from the database
    state.acp_session_store.delete(&session_id).await?;

    // If neither memory nor DB had the session, return 404
    if !in_memory_found {
        // We already deleted from DB; if 0 rows, it was already gone
        // Return 404 only when we have confirmation it doesn't exist
        // (delete is idempotent, so we just return ok even if not found)
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryQuery {
    consolidated: Option<bool>,
}

/// GET /api/sessions/{session_id}/history — Get session message history.
///
/// First tries to get history from in-memory AcpManager.
/// Falls back to database if in-memory is empty (e.g. after server restart).
async fn get_session_history(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<serde_json::Value>, ServerError> {
    // Try in-memory history first
    let mut history = state
        .acp_manager
        .get_session_history(&session_id)
        .await
        .unwrap_or_default();

    // Fall back to database if in-memory is empty
    if history.is_empty() {
        history = state
            .acp_session_store
            .get_history(&session_id)
            .await
            .unwrap_or_default();

        // Populate in-memory store for subsequent requests
        if !history.is_empty() {
            for notification in &history {
                state
                    .acp_manager
                    .push_to_history(&session_id, notification.clone())
                    .await;
            }
        }
    }

    // Consolidate if requested (merge consecutive agent_message_chunk into single messages)
    let result = if query.consolidated.unwrap_or(false) {
        consolidate_message_history(history)
    } else {
        history
    };

    Ok(Json(serde_json::json!({ "history": result })))
}

/// Consolidates consecutive agent_message_chunk notifications into a single message.
/// This reduces storage overhead from hundreds of small chunks to a single entry.
fn consolidate_message_history(notifications: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    if notifications.is_empty() {
        return vec![];
    }

    let mut result: Vec<serde_json::Value> = Vec::new();
    let mut current_chunks: Vec<String> = Vec::new();
    let mut current_session_id: Option<String> = None;

    let flush_chunks = |result: &mut Vec<serde_json::Value>,
                        chunks: &mut Vec<String>,
                        session_id: &Option<String>| {
        if !chunks.is_empty() {
            if let Some(sid) = session_id {
                result.push(serde_json::json!({
                    "sessionId": sid,
                    "update": {
                        "sessionUpdate": "agent_message",
                        "content": { "type": "text", "text": chunks.join("") }
                    }
                }));
            }
            chunks.clear();
        }
    };

    for notification in notifications {
        let session_id = notification
            .get("sessionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let session_update = notification
            .get("update")
            .and_then(|u| u.get("sessionUpdate"))
            .and_then(|v| v.as_str());

        if session_update == Some("agent_message_chunk") {
            // Accumulate chunks
            let text = notification
                .get("update")
                .and_then(|u| u.get("content"))
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str());

            if let Some(text) = text {
                if current_session_id != session_id {
                    flush_chunks(&mut result, &mut current_chunks, &current_session_id);
                    current_session_id = session_id;
                }
                current_chunks.push(text.to_string());
            }
        } else {
            // Non-chunk notification - flush any pending chunks first
            flush_chunks(&mut result, &mut current_chunks, &current_session_id);
            current_session_id = session_id;
            result.push(notification);
        }
    }

    // Flush any remaining chunks
    flush_chunks(&mut result, &mut current_chunks, &current_session_id);

    result
}

/// GET /api/sessions/{session_id}/context — Get hierarchical context for a session.
///
/// Returns the session's parent, children, siblings, and recent workspace sessions.
/// Mirrors the Next.js `GET /api/sessions/[sessionId]/context` route.
async fn get_session_context(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, ServerError> {
    // Build a unified flat list of all sessions (in-memory + DB)
    let in_memory_sessions = state.acp_manager.list_sessions().await;
    let in_memory_ids: std::collections::HashSet<String> =
        in_memory_sessions.iter().map(|s| s.session_id.clone()).collect();

    // Collect all sessions as JSON objects
    let mut all_sessions: Vec<serde_json::Value> = in_memory_sessions
        .iter()
        .map(|s| serde_json::json!({
            "sessionId": s.session_id,
            "name": s.name,
            "cwd": s.cwd,
            "workspaceId": s.workspace_id,
            "routaAgentId": s.routa_agent_id,
            "provider": s.provider,
            "role": s.role,
            "modeId": s.mode_id,
            "model": s.model,
            "createdAt": s.created_at,
            "parentSessionId": s.parent_session_id,
            "firstPromptSent": true,
        }))
        .collect();

    if let Ok(db_sessions) = state.acp_session_store.list(None, Some(500)).await {
        for db in db_sessions {
            if !in_memory_ids.contains(&db.id) {
                all_sessions.push(serde_json::json!({
                    "sessionId": db.id,
                    "name": db.name,
                    "cwd": db.cwd,
                    "workspaceId": db.workspace_id,
                    "routaAgentId": db.routa_agent_id,
                    "provider": db.provider,
                    "role": db.role,
                    "modeId": db.mode_id,
                    "model": null,
                    "createdAt": db.created_at,
                    "parentSessionId": db.parent_session_id,
                    "firstPromptSent": db.first_prompt_sent,
                }));
            }
        }
    }

    // Find the current session
    let current = all_sessions
        .iter()
        .find(|s| s.get("sessionId").and_then(|v| v.as_str()) == Some(&session_id))
        .cloned()
        .ok_or_else(|| ServerError::NotFound("Session not found".to_string()))?;

    let workspace_id = current
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let parent_session_id = current
        .get("parentSessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Helper: is the session non-empty (firstPromptSent is not false)
    let is_non_empty = |s: &serde_json::Value| {
        s.get("firstPromptSent").and_then(|v| v.as_bool()).unwrap_or(true)
    };

    // Parent session
    let parent = parent_session_id.as_ref().and_then(|pid| {
        all_sessions.iter().find(|s| {
            s.get("sessionId").and_then(|v| v.as_str()) == Some(pid.as_str())
        }).cloned()
    });

    // Child sessions
    let children: Vec<_> = all_sessions.iter().filter(|s| {
        s.get("parentSessionId").and_then(|v| v.as_str()) == Some(&session_id)
            && is_non_empty(s)
    }).cloned().collect();

    // Sibling sessions (same parent, not current, non-empty)
    let siblings: Vec<_> = if let Some(ref pid) = parent_session_id {
        all_sessions.iter().filter(|s| {
            s.get("parentSessionId").and_then(|v| v.as_str()) == Some(pid.as_str())
                && s.get("sessionId").and_then(|v| v.as_str()) != Some(&session_id)
                && is_non_empty(s)
        }).cloned().collect()
    } else {
        vec![]
    };

    // Build exclusion set
    let mut exclude_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    exclude_ids.insert(session_id.clone());
    if let Some(ref pid) = parent_session_id {
        exclude_ids.insert(pid.clone());
    }
    for c in &children {
        if let Some(id) = c.get("sessionId").and_then(|v| v.as_str()) {
            exclude_ids.insert(id.to_string());
        }
    }
    for s in &siblings {
        if let Some(id) = s.get("sessionId").and_then(|v| v.as_str()) {
            exclude_ids.insert(id.to_string());
        }
    }

    // Recent sessions in the same workspace (most recent first, limit 5)
    let mut recent_in_workspace: Vec<_> = all_sessions.iter().filter(|s| {
        let sid = s.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
        let ws = s.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("");
        ws == workspace_id && !exclude_ids.contains(sid) && is_non_empty(s)
    }).cloned().collect();

    // Sort by createdAt descending
    recent_in_workspace.sort_by(|a, b| {
        let a_time = a.get("createdAt")
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()))))
            .unwrap_or(0);
        let b_time = b.get("createdAt")
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()))))
            .unwrap_or(0);
        b_time.cmp(&a_time)
    });
    recent_in_workspace.truncate(5);

    Ok(Json(serde_json::json!({
        "current": current,
        "parent": parent,
        "children": children,
        "siblings": siblings,
        "recentInWorkspace": recent_in_workspace,
    })))
}
