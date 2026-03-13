use chrono::Utc;

use crate::error::ServerError;
use crate::models::task::{Task, TaskPriority, TaskStatus};
use crate::state::AppState;

#[derive(Clone)]
pub struct TaskApplicationService {
    state: AppState,
}

impl TaskApplicationService {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    pub async fn create_task(
        &self,
        command: CreateTaskCommand,
    ) -> Result<CreateTaskPlan, ServerError> {
        let CreateTaskCommand {
            title,
            objective,
            workspace_id,
            session_id,
            scope,
            acceptance_criteria,
            verification_commands,
            dependencies,
            parallel_group,
            board_id,
            column_id,
            position,
            priority,
            labels,
            assignee,
            assigned_provider,
            assigned_role,
            assigned_specialist_id,
            assigned_specialist_name,
            create_github_issue,
            repo_path,
        } = command;

        let workspace_id = workspace_id.unwrap_or_else(|| "default".to_string());
        let default_board = self
            .state
            .kanban_store
            .ensure_default_board(&workspace_id)
            .await?;

        let mut task = Task::new(
            uuid::Uuid::new_v4().to_string(),
            title,
            objective,
            workspace_id,
            session_id,
            scope,
            acceptance_criteria,
            verification_commands,
            dependencies,
            parallel_group,
        );
        task.board_id = board_id.or_else(|| Some(default_board.id.clone()));
        task.column_id = column_id.or_else(|| Some("backlog".to_string()));
        task.status = column_id_to_task_status(task.column_id.as_deref());
        task.position = position.unwrap_or(0);
        task.priority = parse_priority(priority)?;
        task.labels = sanitize_labels(labels.unwrap_or_default());
        task.assignee = assignee;
        task.assigned_provider = assigned_provider;
        task.assigned_role = assigned_role;
        task.assigned_specialist_id = assigned_specialist_id;
        task.assigned_specialist_name = assigned_specialist_name;

        Ok(CreateTaskPlan {
            task,
            create_github_issue: create_github_issue.unwrap_or(false),
            repo_path,
        })
    }

    pub async fn update_task(
        &self,
        task_id: &str,
        command: UpdateTaskCommand,
    ) -> Result<UpdateTaskPlan, ServerError> {
        let Some(mut task) = self.state.task_store.get(task_id).await? else {
            return Err(ServerError::NotFound(format!("Task {} not found", task_id)));
        };

        let existing_column_id = task.column_id.clone();
        let has_status_update = command.status.is_some();
        let has_column_update = command.column_id.is_some();
        let has_assigned_provider_update = command.assigned_provider.is_some();
        let has_assigned_role_update = command.assigned_role.is_some();
        let has_assigned_specialist_update = command.assigned_specialist_id.is_some();
        let retry_trigger = command.retry_trigger.unwrap_or(false);
        let should_sync_github = command.sync_to_github != Some(false);
        let repo_path = command.repo_path.clone();

        if let Some(value) = command.title {
            task.title = value;
        }
        if let Some(value) = command.objective {
            task.objective = value;
        }
        if let Some(value) = command.scope {
            task.scope = Some(value);
        }
        if let Some(value) = command.acceptance_criteria {
            task.acceptance_criteria = Some(value);
        }
        if let Some(value) = command.verification_commands {
            task.verification_commands = Some(value);
        }
        if let Some(value) = command.assigned_to {
            task.assigned_to = Some(value);
        }
        if let Some(value) = command.status {
            task.status = TaskStatus::from_str(&value)
                .ok_or_else(|| ServerError::BadRequest(format!("Invalid status: {}", value)))?;
        }
        if command.board_id.is_some() {
            task.board_id = command.board_id;
        }
        if command.column_id.is_some() {
            task.column_id = command.column_id;
        }
        if let Some(value) = command.position {
            task.position = value;
        }
        if let Some(value) = command.priority {
            task.priority =
                Some(TaskPriority::from_str(&value).ok_or_else(|| {
                    ServerError::BadRequest(format!("Invalid priority: {}", value))
                })?);
        }
        if let Some(value) = command.labels {
            task.labels = sanitize_labels(value);
        }
        if command.assignee.is_some() {
            task.assignee = command.assignee;
        }
        if command.assigned_provider.is_some() {
            task.assigned_provider = command.assigned_provider;
        }
        if command.assigned_role.is_some() {
            task.assigned_role = command.assigned_role;
        }
        if command.assigned_specialist_id.is_some() {
            task.assigned_specialist_id = command.assigned_specialist_id;
        }
        if command.assigned_specialist_name.is_some() {
            task.assigned_specialist_name = command.assigned_specialist_name;
        }
        if command.trigger_session_id.is_some() {
            task.trigger_session_id = command.trigger_session_id;
        }
        if command.github_id.is_some() {
            task.github_id = command.github_id;
        }
        if command.github_number.is_some() {
            task.github_number = command.github_number;
        }
        if command.github_url.is_some() {
            task.github_url = command.github_url;
        }
        if command.github_repo.is_some() {
            task.github_repo = command.github_repo;
        }
        if command.github_state.is_some() {
            task.github_state = command.github_state;
        }
        if command.last_sync_error.is_some() {
            task.last_sync_error = command.last_sync_error;
        }
        if let Some(value) = command.dependencies {
            task.dependencies = value;
        }
        if command.parallel_group.is_some() {
            task.parallel_group = command.parallel_group;
        }
        if command.completion_summary.is_some() {
            task.completion_summary = command.completion_summary;
        }
        if command.verification_report.is_some() {
            task.verification_report = command.verification_report;
        }

        if retry_trigger {
            task.trigger_session_id = None;
            task.last_sync_error = None;
        }

        if has_column_update && has_status_update {
            let expected_status = column_id_to_task_status(task.column_id.as_deref());
            let expected_column_id = task_status_to_column_id(&task.status);
            if expected_status != task.status
                || task.column_id.as_deref() != Some(expected_column_id)
            {
                return Err(ServerError::BadRequest(
                    "columnId and status must describe the same workflow state".to_string(),
                ));
            }
        }

        if has_column_update && !has_status_update {
            task.status = column_id_to_task_status(task.column_id.as_deref());
        }
        if has_status_update && !has_column_update {
            task.column_id = Some(task_status_to_column_id(&task.status).to_string());
        }

        let entering_dev = task.column_id.as_deref() == Some("dev")
            && existing_column_id.as_deref() != Some("dev");
        let assigned_while_in_dev = task.column_id.as_deref() == Some("dev")
            && task.trigger_session_id.is_none()
            && (has_assigned_provider_update
                || has_assigned_specialist_update
                || has_assigned_role_update);
        let should_trigger_agent = (entering_dev || assigned_while_in_dev || retry_trigger)
            && task.trigger_session_id.is_none();

        task.updated_at = Utc::now();

        Ok(UpdateTaskPlan {
            task,
            should_sync_github,
            should_trigger_agent,
            repo_path,
        })
    }
}

#[derive(Debug)]
pub struct CreateTaskCommand {
    pub title: String,
    pub objective: String,
    pub workspace_id: Option<String>,
    pub session_id: Option<String>,
    pub scope: Option<String>,
    pub acceptance_criteria: Option<Vec<String>>,
    pub verification_commands: Option<Vec<String>>,
    pub dependencies: Option<Vec<String>>,
    pub parallel_group: Option<String>,
    pub board_id: Option<String>,
    pub column_id: Option<String>,
    pub position: Option<i64>,
    pub priority: Option<String>,
    pub labels: Option<Vec<String>>,
    pub assignee: Option<String>,
    pub assigned_provider: Option<String>,
    pub assigned_role: Option<String>,
    pub assigned_specialist_id: Option<String>,
    pub assigned_specialist_name: Option<String>,
    pub create_github_issue: Option<bool>,
    pub repo_path: Option<String>,
}

#[derive(Debug, Default)]
pub struct UpdateTaskCommand {
    pub title: Option<String>,
    pub objective: Option<String>,
    pub scope: Option<String>,
    pub acceptance_criteria: Option<Vec<String>>,
    pub verification_commands: Option<Vec<String>>,
    pub assigned_to: Option<String>,
    pub status: Option<String>,
    pub board_id: Option<String>,
    pub column_id: Option<String>,
    pub position: Option<i64>,
    pub priority: Option<String>,
    pub labels: Option<Vec<String>>,
    pub assignee: Option<String>,
    pub assigned_provider: Option<String>,
    pub assigned_role: Option<String>,
    pub assigned_specialist_id: Option<String>,
    pub assigned_specialist_name: Option<String>,
    pub trigger_session_id: Option<String>,
    pub github_id: Option<String>,
    pub github_number: Option<i64>,
    pub github_url: Option<String>,
    pub github_repo: Option<String>,
    pub github_state: Option<String>,
    pub last_sync_error: Option<String>,
    pub dependencies: Option<Vec<String>>,
    pub parallel_group: Option<String>,
    pub completion_summary: Option<String>,
    pub verification_report: Option<String>,
    pub sync_to_github: Option<bool>,
    pub retry_trigger: Option<bool>,
    pub repo_path: Option<String>,
}

#[derive(Debug)]
pub struct CreateTaskPlan {
    pub task: Task,
    pub create_github_issue: bool,
    pub repo_path: Option<String>,
}

#[derive(Debug)]
pub struct UpdateTaskPlan {
    pub task: Task,
    pub should_sync_github: bool,
    pub should_trigger_agent: bool,
    pub repo_path: Option<String>,
}

fn parse_priority(priority: Option<String>) -> Result<Option<TaskPriority>, ServerError> {
    match priority {
        Some(value) => Ok(Some(TaskPriority::from_str(&value).ok_or_else(|| {
            ServerError::BadRequest(format!("Invalid priority: {}", value))
        })?)),
        None => Ok(None),
    }
}

fn sanitize_labels(labels: Vec<String>) -> Vec<String> {
    let mut sanitized = Vec::new();
    for label in labels {
        let trimmed = label.trim();
        if !trimmed.is_empty() && !sanitized.iter().any(|item| item == trimmed) {
            sanitized.push(trimmed.to_string());
        }
    }
    sanitized
}

fn column_id_to_task_status(column_id: Option<&str>) -> TaskStatus {
    match column_id.unwrap_or("backlog").to_ascii_lowercase().as_str() {
        "dev" => TaskStatus::InProgress,
        "review" => TaskStatus::ReviewRequired,
        "blocked" => TaskStatus::Blocked,
        "done" => TaskStatus::Completed,
        _ => TaskStatus::Pending,
    }
}

fn task_status_to_column_id(status: &TaskStatus) -> &'static str {
    match status {
        TaskStatus::InProgress => "dev",
        TaskStatus::ReviewRequired => "review",
        TaskStatus::Blocked => "blocked",
        TaskStatus::Completed => "done",
        _ => "backlog",
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{CreateTaskCommand, TaskApplicationService, UpdateTaskCommand};
    use crate::create_app_state;
    use crate::models::task::{Task, TaskStatus};

    fn random_db_path() -> PathBuf {
        std::env::temp_dir().join(format!("routa-task-service-{}.db", uuid::Uuid::new_v4()))
    }

    async fn setup_service() -> (TaskApplicationService, PathBuf) {
        let db_path = random_db_path();
        let state = create_app_state(db_path.to_string_lossy().as_ref())
            .await
            .expect("create app state");
        (TaskApplicationService::new(state), db_path)
    }

    async fn seed_task(service: &TaskApplicationService, column_id: Option<&str>) -> Task {
        let plan = service
            .create_task(CreateTaskCommand {
                title: "Seed task".to_string(),
                objective: "Seed objective".to_string(),
                workspace_id: Some("default".to_string()),
                session_id: None,
                scope: None,
                acceptance_criteria: None,
                verification_commands: None,
                dependencies: None,
                parallel_group: None,
                board_id: None,
                column_id: column_id.map(str::to_string),
                position: None,
                priority: None,
                labels: None,
                assignee: None,
                assigned_provider: None,
                assigned_role: None,
                assigned_specialist_id: None,
                assigned_specialist_name: None,
                create_github_issue: None,
                repo_path: None,
            })
            .await
            .expect("build seed task");
        service
            .state
            .task_store
            .save(&plan.task)
            .await
            .expect("persist seed task");
        plan.task
    }

    #[tokio::test]
    async fn create_task_applies_defaults_and_normalizes_labels() {
        let (service, db_path) = setup_service().await;

        let plan = service
            .create_task(CreateTaskCommand {
                title: "Task service".to_string(),
                objective: "Verify defaults".to_string(),
                workspace_id: None,
                session_id: None,
                scope: None,
                acceptance_criteria: None,
                verification_commands: None,
                dependencies: None,
                parallel_group: None,
                board_id: None,
                column_id: Some("review".to_string()),
                position: None,
                priority: Some("high".to_string()),
                labels: Some(vec![
                    " bug ".to_string(),
                    "bug".to_string(),
                    "".to_string(),
                    "backend".to_string(),
                ]),
                assignee: None,
                assigned_provider: None,
                assigned_role: None,
                assigned_specialist_id: None,
                assigned_specialist_name: None,
                create_github_issue: Some(true),
                repo_path: Some("/tmp/repo".to_string()),
            })
            .await
            .expect("create task plan");

        assert_eq!(plan.task.workspace_id, "default");
        assert!(plan.task.board_id.is_some());
        assert_eq!(plan.task.column_id.as_deref(), Some("review"));
        assert_eq!(plan.task.status, TaskStatus::ReviewRequired);
        assert_eq!(
            plan.task.labels,
            vec!["bug".to_string(), "backend".to_string()]
        );
        assert_eq!(
            plan.task.priority.as_ref().map(|value| value.as_str()),
            Some("high")
        );
        assert!(plan.create_github_issue);
        assert_eq!(plan.repo_path.as_deref(), Some("/tmp/repo"));

        let _ = fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn create_task_rejects_invalid_priority() {
        let (service, db_path) = setup_service().await;

        let error = service
            .create_task(CreateTaskCommand {
                title: "Task service".to_string(),
                objective: "Verify priority validation".to_string(),
                workspace_id: None,
                session_id: None,
                scope: None,
                acceptance_criteria: None,
                verification_commands: None,
                dependencies: None,
                parallel_group: None,
                board_id: None,
                column_id: None,
                position: None,
                priority: Some("impossible".to_string()),
                labels: None,
                assignee: None,
                assigned_provider: None,
                assigned_role: None,
                assigned_specialist_id: None,
                assigned_specialist_name: None,
                create_github_issue: None,
                repo_path: None,
            })
            .await
            .expect_err("invalid priority should fail");

        assert!(error.to_string().contains("Invalid priority"));
        let _ = fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn update_task_rejects_mismatched_column_and_status() {
        let (service, db_path) = setup_service().await;
        let task = seed_task(&service, Some("backlog")).await;

        let error = service
            .update_task(
                &task.id,
                UpdateTaskCommand {
                    column_id: Some("done".to_string()),
                    status: Some("IN_PROGRESS".to_string()),
                    ..UpdateTaskCommand::default()
                },
            )
            .await
            .expect_err("mismatched workflow state should fail");

        assert!(error.to_string().contains("columnId and status"));
        let _ = fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn update_task_derives_column_and_retry_trigger_flags() {
        let (service, db_path) = setup_service().await;
        let mut task = seed_task(&service, Some("backlog")).await;
        task.trigger_session_id = Some("session-1".to_string());
        task.last_sync_error = Some("old error".to_string());
        service
            .state
            .task_store
            .save(&task)
            .await
            .expect("persist updated seed task");

        let plan = service
            .update_task(
                &task.id,
                UpdateTaskCommand {
                    status: Some("IN_PROGRESS".to_string()),
                    retry_trigger: Some(true),
                    sync_to_github: Some(false),
                    ..UpdateTaskCommand::default()
                },
            )
            .await
            .expect("update task plan");

        assert_eq!(plan.task.column_id.as_deref(), Some("dev"));
        assert_eq!(plan.task.status, TaskStatus::InProgress);
        assert_eq!(plan.task.trigger_session_id, None);
        assert_eq!(plan.task.last_sync_error, None);
        assert!(plan.should_trigger_agent);
        assert!(!plan.should_sync_github);

        let _ = fs::remove_file(db_path);
    }
}
