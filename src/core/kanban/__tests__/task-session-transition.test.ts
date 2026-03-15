import { describe, expect, it } from "vitest";

import { archiveActiveTaskSession, prepareTaskForColumnChange } from "../task-session-transition";

describe("task-session-transition", () => {
  it("archives the active session without duplicating it", () => {
    const task = {
      triggerSessionId: "session-2",
      sessionIds: ["session-1", "session-2"],
    };

    archiveActiveTaskSession(task);

    expect(task.sessionIds).toEqual(["session-1", "session-2"]);
  });

  it("archives and clears the active session when a card changes columns", () => {
    const task = {
      columnId: "review",
      triggerSessionId: "session-dev-1",
      sessionIds: ["session-backlog-1"],
      lastSyncError: "stale error",
    };

    const changed = prepareTaskForColumnChange("dev", task);

    expect(changed).toBe(true);
    expect(task.sessionIds).toEqual(["session-backlog-1", "session-dev-1"]);
    expect(task.triggerSessionId).toBeUndefined();
    expect(task.lastSyncError).toBeUndefined();
  });

  it("leaves the active session alone when the card stays in the same column", () => {
    const task = {
      columnId: "dev",
      triggerSessionId: "session-dev-1",
      sessionIds: ["session-backlog-1"],
      lastSyncError: "keep me",
    };

    const changed = prepareTaskForColumnChange("dev", task);

    expect(changed).toBe(false);
    expect(task.sessionIds).toEqual(["session-backlog-1"]);
    expect(task.triggerSessionId).toBe("session-dev-1");
    expect(task.lastSyncError).toBe("keep me");
  });
});
