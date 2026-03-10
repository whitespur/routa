use axum::{
    extract::Path,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use std::path::PathBuf;

use crate::error::ServerError;
use crate::state::AppState;

const FLOWS_SUBDIR: &str = "resources/flows";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_workflows).post(create_workflow))
        .route(
            "/{id}",
            get(get_workflow)
                .put(update_workflow)
                .delete(delete_workflow),
        )
}

fn flows_dir() -> Result<PathBuf, ServerError> {
    let cwd = std::env::current_dir()
        .map_err(|e| ServerError::Internal(format!("Failed to get cwd: {}", e)))?;
    let dir = cwd.join(FLOWS_SUBDIR);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| ServerError::Internal(format!("Failed to create flows dir: {}", e)))?;
    }
    Ok(dir)
}

fn parse_workflow(id: &str, content: &str) -> serde_json::Value {
    let parsed: serde_yaml::Value = serde_yaml::from_str(content).unwrap_or_default();
    let name = parsed.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(id);
    let description = parsed.get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let version = parsed.get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0");
    let trigger = parsed.get("trigger")
        .map(|v| serde_json::to_value(v).unwrap_or_default())
        .unwrap_or(serde_json::Value::Null);
    let steps = parsed.get("steps")
        .map(|v| serde_json::to_value(v).unwrap_or_default())
        .unwrap_or(serde_json::json!([]));

    serde_json::json!({
        "id": id,
        "name": name,
        "description": description,
        "version": version,
        "trigger": trigger,
        "steps": steps,
        "yamlContent": content,
    })
}

/// GET /api/workflows — List all workflow YAML definitions.
async fn list_workflows() -> Result<Json<serde_json::Value>, ServerError> {
    let dir = flows_dir()?;
    let mut workflows = Vec::new();

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| ServerError::Internal(format!("Failed to read flows dir: {}", e)))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "yaml" && ext != "yml" {
            continue;
        }
        let id = path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(content) => workflows.push(parse_workflow(&id, &content)),
            Err(_) => continue,
        }
    }

    Ok(Json(serde_json::json!({ "workflows": workflows })))
}

#[derive(Debug, Deserialize)]
struct CreateWorkflowInput {
    id: String,
    #[serde(rename = "yamlContent")]
    yaml_content: String,
}

/// POST /api/workflows — Create a new workflow YAML file.
async fn create_workflow(
    Json(body): Json<CreateWorkflowInput>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), ServerError> {
    // Validate ID format
    let id_re = regex::Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap();
    if !id_re.is_match(&body.id) {
        return Err(ServerError::BadRequest(
            "ID must contain only letters, numbers, hyphens, and underscores".to_string(),
        ));
    }

    // Validate YAML
    let parsed: serde_yaml::Value = serde_yaml::from_str(&body.yaml_content)
        .map_err(|e| ServerError::BadRequest(format!("Invalid YAML: {}", e)))?;

    let has_name = parsed.get("name").and_then(|v| v.as_str()).is_some();
    let has_steps = parsed.get("steps")
        .and_then(|v| v.as_sequence())
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    if !has_name || !has_steps {
        return Err(ServerError::BadRequest(
            "Workflow YAML must have name and at least one step".to_string(),
        ));
    }

    let dir = flows_dir()?;
    let file_path = dir.join(format!("{}.yaml", body.id));

    if file_path.exists() {
        return Err(ServerError::Conflict(
            format!("Workflow with id \"{}\" already exists", body.id),
        ));
    }

    std::fs::write(&file_path, &body.yaml_content)
        .map_err(|e| ServerError::Internal(format!("Failed to write workflow: {}", e)))?;

    let workflow = parse_workflow(&body.id, &body.yaml_content);
    Ok((axum::http::StatusCode::CREATED, Json(serde_json::json!({ "workflow": workflow }))))
}

/// GET /api/workflows/{id} — Get a specific workflow.
async fn get_workflow(
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ServerError> {
    let dir = flows_dir()?;
    let file_path = dir.join(format!("{}.yaml", id));

    if !file_path.exists() {
        return Err(ServerError::NotFound("Workflow not found".to_string()));
    }

    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| ServerError::Internal(format!("Failed to read workflow: {}", e)))?;

    Ok(Json(serde_json::json!({ "workflow": parse_workflow(&id, &content) })))
}

#[derive(Debug, Deserialize)]
struct UpdateWorkflowInput {
    #[serde(rename = "yamlContent")]
    yaml_content: String,
}

/// PUT /api/workflows/{id} — Update a workflow YAML file.
async fn update_workflow(
    Path(id): Path<String>,
    Json(body): Json<UpdateWorkflowInput>,
) -> Result<Json<serde_json::Value>, ServerError> {
    let dir = flows_dir()?;
    let file_path = dir.join(format!("{}.yaml", id));

    if !file_path.exists() {
        return Err(ServerError::NotFound("Workflow not found".to_string()));
    }

    // Validate YAML
    let parsed: serde_yaml::Value = serde_yaml::from_str(&body.yaml_content)
        .map_err(|e| ServerError::BadRequest(format!("Invalid YAML: {}", e)))?;

    let has_name = parsed.get("name").and_then(|v| v.as_str()).is_some();
    let has_steps = parsed.get("steps")
        .and_then(|v| v.as_sequence())
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    if !has_name || !has_steps {
        return Err(ServerError::BadRequest(
            "Workflow YAML must have name and at least one step".to_string(),
        ));
    }

    std::fs::write(&file_path, &body.yaml_content)
        .map_err(|e| ServerError::Internal(format!("Failed to write workflow: {}", e)))?;

    Ok(Json(serde_json::json!({ "workflow": parse_workflow(&id, &body.yaml_content) })))
}

/// DELETE /api/workflows/{id} — Delete a workflow YAML file.
async fn delete_workflow(
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ServerError> {
    let dir = flows_dir()?;
    let file_path = dir.join(format!("{}.yaml", id));

    if !file_path.exists() {
        return Err(ServerError::NotFound("Workflow not found".to_string()));
    }

    std::fs::remove_file(&file_path)
        .map_err(|e| ServerError::Internal(format!("Failed to delete workflow: {}", e)))?;

    Ok(Json(serde_json::json!({ "success": true })))
}
