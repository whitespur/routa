"use client";

/**
 * TracePanel - Displays Agent Trace records for debugging
 *
 * Shows:
 * - Session lifecycle events (start/end)
 * - User messages
 * - Agent responses (messages, thoughts)
 * - Tool calls and results (with input params as table)
 * - File modifications
 *
 * Based on the Agent Trace specification: https://github.com/cursor/agent-trace
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { desktopAwareFetch } from "../utils/diagnostics";
import type { TraceRecord } from "@/core/trace";
import { MarkdownViewer } from "./markdown/markdown-viewer";
import { ToolInputTable, ToolOutputView } from "./tool-call-content";

interface TracePanelProps {
  sessionId: string | null;
}


/** A merged tool call + result record */
interface MergedToolRecord {
  type: "merged_tool";
  toolCall: TraceRecord;
  toolResult?: TraceRecord;
  toolCallId: string;
}

/** A regular trace record or a merged tool record */
type DisplayRecord = TraceRecord | MergedToolRecord;

function isMergedTool(record: DisplayRecord): record is MergedToolRecord {
  return (record as MergedToolRecord).type === "merged_tool";
}

/**
 * A conversation turn - either a user message or an agent response block
 * Agent response blocks group together: thoughts, messages, and tools
 */
interface ConversationTurn {
  type: "user" | "agent";
  startTime: string;
  endTime: string;
  items: DisplayRecord[];
}

/**
 * Group traces into conversation turns for a continuous flow layout.
 * User messages start a new turn. Agent content (thoughts, messages, tools)
 * are grouped together until the next user message.
 */
function groupIntoConversationTurns(records: DisplayRecord[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentAgentTurn: ConversationTurn | null = null;

  for (const record of records) {
    const trace = isMergedTool(record) ? record.toolCall : record;
    const eventType = isMergedTool(record) ? "tool_call" : trace.eventType;

    if (eventType === "user_message") {
      // Flush current agent turn if any
      if (currentAgentTurn && currentAgentTurn.items.length > 0) {
        turns.push(currentAgentTurn);
        currentAgentTurn = null;
      }
      // User message is its own turn
      turns.push({
        type: "user",
        startTime: trace.timestamp,
        endTime: trace.timestamp,
        items: [record],
      });
    } else if (
      eventType === "agent_message" ||
      eventType === "agent_thought" ||
      eventType === "tool_call" ||
      isMergedTool(record)
    ) {
      // Agent content - add to current agent turn or create new one
      if (!currentAgentTurn) {
        currentAgentTurn = {
          type: "agent",
          startTime: trace.timestamp,
          endTime: trace.timestamp,
          items: [],
        };
      }
      currentAgentTurn.items.push(record);
      currentAgentTurn.endTime = trace.timestamp;
    } else if (eventType === "session_start" || eventType === "session_end") {
      // Session events - flush agent turn and add as separate item
      if (currentAgentTurn && currentAgentTurn.items.length > 0) {
        turns.push(currentAgentTurn);
        currentAgentTurn = null;
      }
      turns.push({
        type: "agent", // Use agent type for session events
        startTime: trace.timestamp,
        endTime: trace.timestamp,
        items: [record],
      });
    }
    // Skip tool_result as they are merged with tool_call
  }

  // Flush remaining agent turn
  if (currentAgentTurn && currentAgentTurn.items.length > 0) {
    turns.push(currentAgentTurn);
  }

  return turns;
}

/**
 * Merge tool_call and tool_result traces by toolCallId.
 * Returns a mixed array of regular traces and merged tool records.
 */
function mergeToolTraces(traces: TraceRecord[]): DisplayRecord[] {
  const result: DisplayRecord[] = [];
  const processedResultIds = new Set<string>();

  // First pass: find all tool_calls and mark their matching results
  for (const trace of traces) {
    if (trace.eventType === "tool_result" && trace.tool?.toolCallId) {
      const hasMatchingCall = traces.some(
        (t) => t.eventType === "tool_call" && t.tool?.toolCallId === trace.tool?.toolCallId
      );
      if (hasMatchingCall) {
        processedResultIds.add(trace.id);
      }
    }
  }

  // Build the result array
  for (const trace of traces) {
    if (trace.eventType === "tool_call" && trace.tool?.toolCallId) {
      // Find matching result
      const matchingResult = traces.find(
        (t) =>
          t.eventType === "tool_result" &&
          t.tool?.toolCallId === trace.tool?.toolCallId
      );
      result.push({
        type: "merged_tool",
        toolCall: trace,
        toolResult: matchingResult,
        toolCallId: trace.tool.toolCallId,
      });
    } else if (trace.eventType === "tool_result" && trace.tool?.toolCallId) {
      // Skip if already merged with a tool_call
      if (processedResultIds.has(trace.id)) {
        continue;
      }
      // Orphan result (no matching call) - still show it
      result.push(trace);
    } else {
      // All other event types
      result.push(trace);
    }
  }

  return result;
}

/**
 * Infer actual tool name from input parameters when name is "other" or "unknown".
 * This handles cases where the ACP provider doesn't send the correct tool name.
 */
function inferToolName(name: string, input: unknown): string {
  if (name !== "other" && name !== "unknown") {
    return name;
  }

  if (!input || typeof input !== "object") {
    return name;
  }

  const inputObj = input as Record<string, unknown>;

  // codebase-retrieval: has "information_request" parameter
  if ("information_request" in inputObj) {
    return "codebase-retrieval";
  }

  // file read operations
  if ("file_path" in inputObj && !("content" in inputObj)) {
    return "read-file";
  }

  // file write operations
  if ("file_path" in inputObj && "content" in inputObj) {
    return "write-file";
  }

  // shell/bash commands
  if ("command" in inputObj) {
    return "shell";
  }

  // web search
  if ("query" in inputObj && "num_results" in inputObj) {
    return "web-search";
  }

  // web fetch
  if ("url" in inputObj && !("query" in inputObj)) {
    return "web-fetch";
  }

  return name;
}

/** Inline tool display for conversation flow - compact, non-intrusive */
function InlineToolView({
  merged,
  formatTime,
}: {
  merged: MergedToolRecord;
  formatTime: (timestamp: string) => string;
}) {
  const [expanded, setExpanded] = useState(true); // Default expanded
  const { toolCall, toolResult } = merged;
  const rawToolName = toolCall.tool?.name ?? "unknown";
  const toolName = inferToolName(rawToolName, toolCall.tool?.input);
  const status = toolResult?.tool?.status ?? toolCall.tool?.status ?? "running";

  const rawOutput = toolResult?.tool?.output;
  const outputStr =
    rawOutput == null
      ? ""
      : typeof rawOutput === "string"
        ? rawOutput
        : JSON.stringify(rawOutput, null, 2);

  const statusIcon = status === "completed" ? "✓" : status === "failed" ? "✗" : "⏳";
  const statusColor =
    status === "completed"
      ? "text-green-600 dark:text-green-400"
      : status === "failed"
        ? "text-red-600 dark:text-red-400"
        : "text-yellow-600 dark:text-yellow-400 animate-pulse";

  // Generate a brief summary of the tool input
  const inputSummary = useMemo(() => {
    const input = toolCall.tool?.input;
    if (!input) return "";
    if (typeof input === "string") return input.slice(0, 50);
    const obj = input as Record<string, unknown>;
    // Show key field based on tool type
    if (obj.url) return String(obj.url).slice(0, 50);
    if (obj.path) return String(obj.path);
    if (obj.file_path) return String(obj.file_path);
    if (obj.command) return String(obj.command).slice(0, 50);
    if (obj.information_request) return String(obj.information_request).slice(0, 40);
    if (obj.query) return String(obj.query).slice(0, 40);
    return "";
  }, [toolCall.tool?.input]);

  return (
    <div className="my-2">
      {/* Compact tool header - inline with flow */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-50/50 dark:bg-orange-900/10 border border-orange-100 dark:border-orange-800/30 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-colors w-full text-left"
      >
        <svg
          className={`w-3 h-3 text-orange-400 transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-[10px] text-orange-500 dark:text-orange-400">🔧</span>
        <code className="text-[11px] font-mono font-medium text-orange-700 dark:text-orange-300">
          {toolName}
        </code>
        {inputSummary && (
          <>
            <span className="text-gray-300 dark:text-gray-600">→</span>
            <span className="text-[10px] text-gray-500 dark:text-gray-400 truncate flex-1 font-mono">
              {inputSummary}
            </span>
          </>
        )}
        <span className={`text-xs shrink-0 ${statusColor}`}>{statusIcon}</span>
        <span className="text-[9px] text-gray-400 dark:text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {formatTime(toolCall.timestamp)}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-2 ml-4 pl-3 border-l-2 border-orange-200 dark:border-orange-800/40 space-y-2">
          {/* Input */}
          {toolCall.tool?.input != null && (
            <div className="rounded-md border border-gray-200 dark:border-gray-700/60 overflow-hidden">
              <div className="px-2 py-1 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700/60">
                <span className="text-[9px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                  Input
                </span>
              </div>
              <div className="px-2 py-1.5 bg-white dark:bg-gray-900/40">
                <ToolInputTable input={toolCall.tool.input} />
              </div>
            </div>
          )}
          {/* Output */}
          {outputStr && (
            <div className="rounded-md border border-cyan-200 dark:border-cyan-800/40 overflow-hidden">
              <ToolOutputView output={rawOutput ?? outputStr} toolName={toolName} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Collapsible thought bubble for conversation flow */
function InlineThoughtView({ trace }: { trace: TraceRecord }) {
  const [expanded, setExpanded] = useState(false);
  const content = trace.conversation?.fullContent || trace.conversation?.contentPreview || "";

  if (!content) return null;

  return (
    <button
      onClick={() => setExpanded(!expanded)}
      className="group flex items-start gap-2 my-1 px-3 py-1.5 rounded-lg bg-yellow-50/40 dark:bg-yellow-900/5 border border-yellow-100/50 dark:border-yellow-800/20 hover:bg-yellow-50/70 dark:hover:bg-yellow-900/10 transition-colors w-full text-left"
    >
      <span className="text-[10px] text-yellow-500 shrink-0 pt-0.5">💭</span>
      <p className={`text-[11px] text-gray-500 dark:text-gray-400 italic leading-relaxed ${expanded ? "" : "line-clamp-2"}`}>
        {content}
      </p>
      {!expanded && content.length > 150 && (
        <span className="text-[9px] text-yellow-500 dark:text-yellow-400 shrink-0 pt-0.5">...</span>
      )}
    </button>
  );
}

/** User message bubble for conversation flow */
function UserMessageBubble({
  trace,
  formatTime,
}: {
  trace: TraceRecord;
  formatTime: (timestamp: string) => string;
}) {
  const content = trace.conversation?.fullContent || trace.conversation?.contentPreview || "";

  return (
    <div className="flex items-start gap-3 group">
      {/* Avatar */}
      <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
        <span className="text-sm">👤</span>
      </div>
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-blue-700 dark:text-blue-300">User</span>
          <span className="text-[10px] text-gray-400 dark:text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
            {formatTime(trace.timestamp)}
          </span>
        </div>
        <div className="px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/30">
          <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words leading-relaxed">
            {content || <span className="italic text-gray-400">(empty)</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Agent response block - groups thoughts, messages, and tools into a continuous flow */
function AgentResponseBlock({
  turn,
  formatTime,
}: {
  turn: ConversationTurn;
  formatTime: (timestamp: string) => string;
}) {
  const [thoughtsExpanded, setThoughtsExpanded] = useState(false);

  // Separate thoughts from other content
  const thoughts: TraceRecord[] = [];
  const messages: TraceRecord[] = [];
  const tools: MergedToolRecord[] = [];
  const sessionEvents: TraceRecord[] = [];

  for (const item of turn.items) {
    if (isMergedTool(item)) {
      tools.push(item);
    } else if (item.eventType === "agent_thought") {
      thoughts.push(item);
    } else if (item.eventType === "agent_message") {
      messages.push(item);
    } else if (item.eventType === "session_start" || item.eventType === "session_end") {
      sessionEvents.push(item);
    }
  }

  // Session events render differently
  if (sessionEvents.length > 0 && messages.length === 0 && tools.length === 0) {
    return (
      <div className="flex items-center gap-2 py-2">
        {sessionEvents.map((evt) => (
          <span
            key={evt.id}
            className={`text-[10px] font-semibold uppercase tracking-wide ${
              evt.eventType === "session_start"
                ? "text-green-600 dark:text-green-400"
                : "text-red-500 dark:text-red-400"
            }`}
          >
            {evt.eventType === "session_start" ? "▶ Session Started" : "■ Session Ended"}
            <span className="ml-2 font-normal text-gray-400">{formatTime(evt.timestamp)}</span>
          </span>
        ))}
      </div>
    );
  }

  // Get model info from first agent message
  const model = messages[0]?.contributor?.model || thoughts[0]?.contributor?.model;

  // Build interleaved content for proper flow
  // Sort all items by timestamp and render in order
  const sortedItems = [...turn.items].sort(
    (a, b) =>
      new Date(isMergedTool(a) ? a.toolCall.timestamp : a.timestamp).getTime() -
      new Date(isMergedTool(b) ? b.toolCall.timestamp : b.timestamp).getTime()
  );

  // Merge consecutive agent_message content
  const mergedContent: Array<{
    type: "thought" | "message" | "tool";
    content?: string;
    trace?: TraceRecord;
    merged?: MergedToolRecord;
  }> = [];

  for (const item of sortedItems) {
    if (isMergedTool(item)) {
      mergedContent.push({ type: "tool", merged: item });
    } else if (item.eventType === "agent_thought") {
      mergedContent.push({ type: "thought", trace: item });
    } else if (item.eventType === "agent_message") {
      const content = item.conversation?.fullContent || item.conversation?.contentPreview || "";
      // Try to merge with previous message
      const last = mergedContent[mergedContent.length - 1];
      if (last && last.type === "message" && last.content !== undefined) {
        last.content += content;
      } else {
        mergedContent.push({ type: "message", content });
      }
    }
  }

  return (
    <div className="flex items-start gap-3 group">
      {/* Avatar */}
      <div className="w-8 h-8 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center shrink-0">
        <span className="text-sm">🤖</span>
      </div>
      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-purple-700 dark:text-purple-300">Agent</span>
          {model && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">{model}</span>
          )}
          <span className="text-[10px] text-gray-400 dark:text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
            {formatTime(turn.startTime)}
            {turn.startTime !== turn.endTime && ` → ${formatTime(turn.endTime)}`}
          </span>
        </div>

        {/* Thoughts toggle (if any) */}
        {thoughts.length > 0 && (
          <button
            onClick={() => setThoughtsExpanded(!thoughtsExpanded)}
            className="flex items-center gap-1.5 mb-2 text-[10px] text-yellow-600 dark:text-yellow-400 hover:text-yellow-700 dark:hover:text-yellow-300"
          >
            <svg
              className={`w-3 h-3 transition-transform ${thoughtsExpanded ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            💭 {thoughts.length} thought{thoughts.length > 1 ? "s" : ""}
          </button>
        )}
        {thoughtsExpanded && thoughts.map((t) => <InlineThoughtView key={t.id} trace={t} />)}

        {/* Main content flow */}
        <div className="space-y-1">
          {mergedContent.map((item, idx) => {
            if (item.type === "thought" && !thoughtsExpanded) {
              // Thoughts handled above
              return null;
            }
            if (item.type === "thought" && thoughtsExpanded) {
              // Already rendered above
              return null;
            }
            if (item.type === "message") {
              return (
                <div key={idx} className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed">
                  <MarkdownViewer content={item.content || ""} className="text-sm" />
                </div>
              );
            }
            if (item.type === "tool" && item.merged) {
              return (
                <InlineToolView
                  key={`tool-${idx}-${item.merged.toolCallId}`}
                  merged={item.merged}
                  formatTime={formatTime}
                />
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

export function TracePanel({ sessionId }: TracePanelProps) {
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const [stats, setStats] = useState<{
    totalDays: number;
    totalFiles: number;
    totalRecords: number;
    uniqueSessions: number;
    eventTypes: Record<string, number>;
  } | null>(null);

  const fetchTraces = useCallback(async () => {
    if (!sessionId) {
      setTraces([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ sessionId });
      const res = await desktopAwareFetch(`/api/traces?${params}`, { cache: "no-store" });

      if (!res.ok) {
        throw new Error(`Failed to fetch traces: ${res.statusText}`);
      }

      const data = await res.json();
      setTraces(data.traces || []);
    } catch (err) {
      console.error("[TracePanel] Failed to fetch traces:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await desktopAwareFetch("/api/traces/stats", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setStats(data.stats || null);
      }
    } catch (err) {
      console.error("[TracePanel] Failed to fetch stats:", err);
    }
  }, []);

  useEffect(() => {
    fetchTraces();
    fetchStats();
  }, [fetchTraces, fetchStats]);

  const exportTraces = useCallback(async () => {
    if (!sessionId) return;

    try {
      const params = new URLSearchParams({ sessionId });
      const res = await desktopAwareFetch(`/api/traces/export?${params}`, { cache: "no-store" });

      if (!res.ok) {
        throw new Error(`Failed to export traces: ${res.statusText}`);
      }

      const data = await res.json();
      const blob = new Blob([JSON.stringify(data.export, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `traces-${sessionId}-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[TracePanel] Failed to export traces:", err);
    }
  }, [sessionId]);

  // Merge tool_call and tool_result by toolCallId
  const mergedRecords = useMemo(() => mergeToolTraces(traces), [traces]);

  // Filter records based on selected filter
  const filteredRecords = useMemo(() => {
    if (filter === "all") return mergedRecords;
    if (filter === "tools") {
      // Show only merged tool records
      return mergedRecords.filter((r) => isMergedTool(r));
    }
    // For tool_call or tool_result filters, show the merged view but only matching items
    if (filter === "tool_call" || filter === "tool_result") {
      return mergedRecords.filter((r) => {
        if (isMergedTool(r)) return true; // Show merged tools
        return r.eventType === filter;
      });
    }
    // For other filters, show non-merged items matching the filter
    return mergedRecords.filter((r) => {
      if (isMergedTool(r)) return false;
      return r.eventType === filter;
    });
  }, [mergedRecords, filter]);

  // Group into conversation turns for continuous flow
  const conversationTurns = useMemo(
    () => groupIntoConversationTurns(filteredRecords),
    [filteredRecords]
  );



  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#13151d]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-gray-500 dark:text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Agent Trace
          </span>
          {traces.length > 0 && (
            <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-full">
              {traces.length}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchTraces}
            disabled={loading}
            className="text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 disabled:opacity-50 transition-colors"
          >
            {loading ? "..." : "Refresh"}
          </button>
          <button
            onClick={exportTraces}
            disabled={traces.length === 0}
            className="px-2 py-1 text-[11px] font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Export
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-800 flex items-center gap-4 text-[10px] text-gray-500 dark:text-gray-400 shrink-0">
          <span>{stats.totalRecords} total records</span>
          <span>{stats.uniqueSessions} sessions</span>
          <span>{stats.totalDays} days</span>
        </div>
      )}

      {/* Filter bar */}
      <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800 flex items-center gap-1.5 shrink-0 overflow-x-auto">
        {(
          [
            { key: "all", label: "All", active: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" },
            { key: "user_message", label: "User", active: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" },
            { key: "agent_message", label: "Agent", active: "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300" },
            { key: "tools", label: "Tools", active: "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300" },
            { key: "agent_thought", label: "Thoughts", active: "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300" },
          ] as const
        ).map(({ key, label, active }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-2 py-1 text-[11px] font-medium rounded-md whitespace-nowrap transition-colors ${
              filter === key
                ? active
                : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && (
        <div className="p-4 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filteredRecords.length === 0 && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <svg
              className="w-12 h-12 text-gray-300 dark:text-gray-700 mx-auto mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {sessionId ? "No traces for this session yet" : "Select a session to view traces"}
            </p>
          </div>
        </div>
      )}

      {/* Trace content - continuous conversation flow */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-6">
          {conversationTurns.map((turn, idx) => {
            if (turn.type === "user") {
              const trace = turn.items[0];
              if (!isMergedTool(trace)) {
                return (
                  <UserMessageBubble
                    key={trace.id}
                    trace={trace}
                    formatTime={formatTime}
                  />
                );
              }
            }
            return (
              <AgentResponseBlock
                key={`turn-${idx}`}
                turn={turn}
                formatTime={formatTime}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
