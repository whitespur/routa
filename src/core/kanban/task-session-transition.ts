import type { Task } from "../models/task";

type TaskSessionState = Pick<Task, "columnId" | "triggerSessionId" | "sessionIds" | "lastSyncError">;

export function archiveActiveTaskSession(task: Pick<Task, "triggerSessionId" | "sessionIds">): void {
  if (!task.triggerSessionId) {
    return;
  }
  if (!task.sessionIds.includes(task.triggerSessionId)) {
    task.sessionIds.push(task.triggerSessionId);
  }
}

export function prepareTaskForColumnChange(
  previousColumnId: string | undefined,
  task: TaskSessionState,
): boolean {
  if (task.columnId === previousColumnId) {
    return false;
  }

  archiveActiveTaskSession(task);
  task.triggerSessionId = undefined;
  task.lastSyncError = undefined;
  return true;
}
