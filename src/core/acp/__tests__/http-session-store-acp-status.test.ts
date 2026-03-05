/**
 * Unit tests for HttpSessionStore.updateSessionAcpStatus
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from "vitest";

// We need to test the store in isolation. Import the class and types.
// The singleton getter is module-scoped, so we test via the exported function.
import { getHttpSessionStore, consolidateMessageHistory } from "../http-session-store";
import type { SessionUpdateNotification } from "../http-session-store";

describe("HttpSessionStore — ACP status", () => {
  beforeEach(() => {
    // Clean up sessions from previous tests
    const store = getHttpSessionStore();
    for (const s of store.listSessions()) {
      store.deleteSession(s.sessionId);
    }
  });

  it("upsertSession stores acpStatus field", () => {
    const store = getHttpSessionStore();
    store.upsertSession({
      sessionId: "test-1",
      cwd: "/tmp",
      workspaceId: "ws-1",
      provider: "opencode",
      acpStatus: "connecting",
      createdAt: new Date().toISOString(),
    });

    const session = store.getSession("test-1");
    expect(session).toBeDefined();
    expect(session!.acpStatus).toBe("connecting");
  });

  it("updateSessionAcpStatus transitions connecting → ready", () => {
    const store = getHttpSessionStore();
    store.upsertSession({
      sessionId: "test-2",
      cwd: "/tmp",
      workspaceId: "ws-1",
      provider: "opencode",
      acpStatus: "connecting",
      createdAt: new Date().toISOString(),
    });

    store.updateSessionAcpStatus("test-2", "ready");

    const session = store.getSession("test-2");
    expect(session!.acpStatus).toBe("ready");
    expect(session!.acpError).toBeUndefined();
  });

  it("updateSessionAcpStatus transitions connecting → error with message", () => {
    const store = getHttpSessionStore();
    store.upsertSession({
      sessionId: "test-3",
      cwd: "/tmp",
      workspaceId: "ws-1",
      provider: "opencode",
      acpStatus: "connecting",
      createdAt: new Date().toISOString(),
    });

    store.updateSessionAcpStatus("test-3", "error", "Process crashed");

    const session = store.getSession("test-3");
    expect(session!.acpStatus).toBe("error");
    expect(session!.acpError).toBe("Process crashed");
  });

  it("updateSessionAcpStatus pushes acp_status notification to history", () => {
    const store = getHttpSessionStore();
    store.upsertSession({
      sessionId: "test-4",
      cwd: "/tmp",
      workspaceId: "ws-1",
      provider: "opencode",
      acpStatus: "connecting",
      createdAt: new Date().toISOString(),
    });

    store.updateSessionAcpStatus("test-4", "ready");

    const history = store.getHistory("test-4");
    expect(history.length).toBeGreaterThanOrEqual(1);

    const statusNotification = history.find(
      (n) => (n.update as Record<string, unknown>)?.sessionUpdate === "acp_status"
    );
    expect(statusNotification).toBeDefined();
    expect((statusNotification!.update as Record<string, unknown>).status).toBe("ready");
  });

  it("updateSessionAcpStatus is a no-op for unknown session", () => {
    const store = getHttpSessionStore();
    // Should not throw
    store.updateSessionAcpStatus("nonexistent", "ready");
    expect(store.getSession("nonexistent")).toBeUndefined();
  });
});

describe("consolidateMessageHistory", () => {
  it("merges consecutive agent_message_chunk into single agent_message", () => {
    const notifications: SessionUpdateNotification[] = [
      { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } } },
      { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } },
    ];

    const result = consolidateMessageHistory(notifications);
    expect(result.length).toBe(1);
    const update = result[0].update as Record<string, unknown>;
    expect(update.sessionUpdate).toBe("agent_message");
    expect((update.content as { text: string }).text).toBe("Hello world");
  });

  it("preserves non-chunk notifications", () => {
    const notifications: SessionUpdateNotification[] = [
      { sessionId: "s1", update: { sessionUpdate: "tool_call", name: "read_file" } },
      { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } },
    ];

    const result = consolidateMessageHistory(notifications);
    expect(result.length).toBe(2);
    expect((result[0].update as Record<string, unknown>).sessionUpdate).toBe("tool_call");
    expect((result[1].update as Record<string, unknown>).sessionUpdate).toBe("agent_message");
  });
});
