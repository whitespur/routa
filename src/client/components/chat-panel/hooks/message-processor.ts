/**
 * Message processing utilities for SSE updates
 */

import { v4 as uuidv4 } from "uuid";
import type { AcpSessionNotification } from "../../../acp-client";
import type { ChatMessage, PlanEntry, UsageInfo } from "../types";
import { parseChecklist, type ChecklistItem } from "../../../utils/checklist-parser";
import {
  type FileChangesState,
  updateFileChange,
  extractFileChangeFromToolResult,
  extractFilesModified,
} from "../../../utils/file-changes-tracker";

type SetState<T> = React.Dispatch<React.SetStateAction<T>>;

/**
 * Process a single SSE update and mutate the messages array
 */
export function processUpdate(
  kind: string,
  update: Record<string, unknown>,
  arr: ChatMessage[],
  sid: string,
  lastKind: string | null,
  extractText: () => string,
  streamingMsgIdRef: React.MutableRefObject<Record<string, string | null>>,
  streamingThoughtIdRef: React.MutableRefObject<Record<string, string | null>>,
  setChecklistItems: SetState<ChecklistItem[]>,
  setFileChangesState: SetState<FileChangesState>,
  setUsageInfo: SetState<UsageInfo | null>,
  modeUpdates: Record<string, string>
): void {
  switch (kind) {
    case "agent_message_chunk": {
      const text = extractText();
      if (!text) break;
      streamingThoughtIdRef.current[sid] = null;

      const shouldCreateNew = lastKind !== "agent_message_chunk";
      if (shouldCreateNew) {
        streamingMsgIdRef.current[sid] = null;
      }

      let msgId = streamingMsgIdRef.current[sid];
      if (!msgId) {
        msgId = uuidv4();
        streamingMsgIdRef.current[sid] = msgId;
      }
      const idx = arr.findIndex((m) => m.id === msgId);
      if (idx >= 0) {
        const updatedContent = arr[idx].content + text;
        arr[idx] = { ...arr[idx], content: updatedContent };
        const parsedChecklist = parseChecklist(updatedContent);
        if (parsedChecklist.length > 0) {
          setChecklistItems(parsedChecklist);
        }
      } else {
        arr.push({ id: msgId, role: "assistant", content: text, timestamp: new Date() });
        const parsedChecklist = parseChecklist(text);
        if (parsedChecklist.length > 0) {
          setChecklistItems(parsedChecklist);
        }
      }
      break;
    }

    case "agent_thought_chunk": {
      const text = extractText();
      if (!text) break;

      const shouldCreateNewThought = lastKind !== "agent_thought_chunk";
      if (shouldCreateNewThought) {
        streamingThoughtIdRef.current[sid] = null;
      }

      let thoughtId = streamingThoughtIdRef.current[sid];
      if (!thoughtId) {
        thoughtId = uuidv4();
        streamingThoughtIdRef.current[sid] = thoughtId;
      }
      const idx = arr.findIndex((m) => m.id === thoughtId);
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], content: arr[idx].content + text };
      } else {
        arr.push({ id: thoughtId, role: "thought", content: text, timestamp: new Date() });
      }
      break;
    }

    case "tool_call": {
      const toolCallId = update.toolCallId as string | undefined;
      const title = (update.title as string) ?? "tool";
      const status = (update.status as string) ?? "running";
      const toolKind = update.kind as string | undefined;
      const rawInput = (typeof update.rawInput === "object" && update.rawInput !== null)
        ? update.rawInput as Record<string, unknown>
        : undefined;
      const contentParts: string[] = [];
      if (update.rawInput) {
        contentParts.push(
          `Input:\n${typeof update.rawInput === "string" ? update.rawInput : JSON.stringify(update.rawInput, null, 2)}`
        );
      }
      const toolContent = update.content as Array<{ type: string; text?: string }> | undefined;
      if (Array.isArray(toolContent)) {
        for (const c of toolContent) {
          if (c.text) contentParts.push(c.text);
        }
      }
      const alreadyExists = toolCallId && arr.some((m) => m.toolCallId === toolCallId);
      if (!alreadyExists) {
        arr.push({
          id: toolCallId ?? uuidv4(),
          role: "tool",
          content: contentParts.join("\n\n") || title,
          timestamp: new Date(),
          toolName: title,
          toolStatus: status,
          toolCallId,
          toolKind,
          toolRawInput: rawInput,
        });
      }
      break;
    }

    case "tool_call_update": {
      processToolCallUpdate(update, arr, setFileChangesState);
      break;
    }

    case "plan": {
      const entries = update.entries as PlanEntry[] | undefined;
      const planText = entries
        ? entries.map((e) => `[${e.status ?? "pending"}] ${e.content}${e.priority ? ` (${e.priority})` : ""}`).join("\n")
        : typeof update.plan === "string" ? update.plan : JSON.stringify(update, null, 2);
      arr.push({ id: uuidv4(), role: "plan", content: planText, timestamp: new Date(), planEntries: entries });
      break;
    }

    case "usage_update": {
      const used = update.used as number | undefined;
      const size = update.size as number | undefined;
      const cost = update.cost as { amount: number; currency: string } | null | undefined;
      const usageIdx = arr.findIndex((m) => m.role === "info" && m.usageUsed !== undefined);
      const usageMsg: ChatMessage = {
        id: usageIdx >= 0 ? arr[usageIdx].id : uuidv4(),
        role: "info",
        content: "",
        timestamp: new Date(),
        usageUsed: used,
        usageSize: size,
        costAmount: cost?.amount,
        costCurrency: cost?.currency,
      };
      if (usageIdx >= 0) {
        arr[usageIdx] = usageMsg;
      } else {
        arr.push(usageMsg);
      }
      break;
    }

    case "current_mode_update": {
      const modeId = update.currentModeId as string | undefined;
      if (modeId) {
        modeUpdates[sid] = modeId;
      }
      break;
    }

    case "terminal_created": {
      const terminalId = update.terminalId as string | undefined;
      const termCommand = update.command as string | undefined;
      const termArgs = update.args as string[] | undefined;
      if (terminalId && !arr.some((m) => m.terminalId === terminalId)) {
        arr.push({
          id: terminalId,
          role: "terminal",
          content: "",
          timestamp: new Date(),
          terminalId,
          terminalCommand: termCommand,
          terminalArgs: termArgs,
          terminalInteractive: true,
          terminalExited: false,
          terminalExitCode: null,
        });
      }
      break;
    }

    case "terminal_output": {
      const terminalId = update.terminalId as string | undefined;
      const termData = update.data as string | undefined;
      if (terminalId && termData) {
        const idx = arr.findIndex((m) => m.role === "terminal" && m.terminalId === terminalId);
        if (idx >= 0) {
          arr[idx] = { ...arr[idx], content: arr[idx].content + termData };
        } else {
          arr.push({
            id: terminalId,
            role: "terminal",
            content: termData,
            timestamp: new Date(),
            terminalId,
            terminalInteractive: true,
            terminalExited: false,
            terminalExitCode: null,
          });
        }
      }
      break;
    }

    case "terminal_exited": {
      const terminalId = update.terminalId as string | undefined;
      const termExitCode = update.exitCode as number | undefined;
      if (terminalId) {
        const idx = arr.findIndex((m) => m.role === "terminal" && m.terminalId === terminalId);
        if (idx >= 0) {
          arr[idx] = { ...arr[idx], terminalExited: true, terminalExitCode: termExitCode ?? 0 };
        }
      }
      break;
    }

    case "process_output": {
      const processData = update.data as string | undefined;
      const processSource = update.source as string | undefined;
      const processDisplayName = update.displayName as string | undefined;
      if (processData) {
        const processTermId = `process-${sid}`;
        const idx = arr.findIndex((m) => m.role === "terminal" && m.terminalId === processTermId);
        if (idx >= 0) {
          arr[idx] = { ...arr[idx], content: arr[idx].content + processData };
        } else {
          arr.push({
            id: processTermId,
            role: "terminal",
            content: processData,
            timestamp: new Date(),
            terminalId: processTermId,
            terminalCommand: processDisplayName ?? "Agent Process",
            terminalArgs: processSource ? [processSource] : undefined,
            terminalInteractive: false,
            terminalExited: false,
            terminalExitCode: null,
          });
        }
      }
      break;
    }

    case "task_completion": {
      processTaskCompletion(update, arr, setFileChangesState);
      break;
    }

    case "tool_call_start": {
      const toolCallId = update.toolCallId as string | undefined;
      const toolName = update.toolName as string | undefined;
      const toolKind = update.kind as string | undefined;
      if (toolCallId) {
        arr.push({
          id: toolCallId,
          role: "tool",
          content: `${toolName ?? "tool"}\n\n(streaming parameters...)`,
          timestamp: new Date(),
          toolName: toolName ?? "tool",
          toolStatus: "streaming",
          toolCallId,
          toolKind,
        });
      }
      break;
    }

    case "tool_call_params_delta": {
      const toolCallId = update.toolCallId as string | undefined;
      const parsedInput = update.parsedInput as Record<string, unknown> | null;
      const title = update.title as string | undefined;
      if (toolCallId) {
        const idx = arr.findIndex((m) => m.toolCallId === toolCallId);
        if (idx >= 0) {
          const existing = arr[idx];
          const inputPreview = parsedInput
            ? `Input:\n${JSON.stringify(parsedInput, null, 2)}`
            : "(streaming parameters...)";
          arr[idx] = {
            ...existing,
            content: `${title ?? existing.toolName ?? "tool"}\n\n${inputPreview}`,
            toolRawInput: parsedInput ?? existing.toolRawInput,
          };
        }
      }
      break;
    }

    case "thinking_start": {
      const thoughtId = `thinking-${uuidv4()}`;
      streamingThoughtIdRef.current[sid] = thoughtId;
      arr.push({ id: thoughtId, role: "thought", content: "", timestamp: new Date() });
      break;
    }

    case "thinking_stop": {
      const reasoningText = update.reasoningText as string | undefined;
      const thoughtId = streamingThoughtIdRef.current[sid];
      if (thoughtId && reasoningText) {
        const idx = arr.findIndex((m) => m.id === thoughtId);
        if (idx >= 0) {
          arr[idx] = { ...arr[idx], content: reasoningText };
        }
      }
      streamingThoughtIdRef.current[sid] = null;
      break;
    }

    case "thinking_signature":
      break;

    case "turn_complete": {
      const usage = update.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const stopReason = update.stopReason as string | undefined;

      if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        setUsageInfo({
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        });
      }

      if (stopReason === "max_tokens") {
        arr.push({
          id: uuidv4(),
          role: "info",
          content: "⚠️ Response was truncated due to max tokens limit.",
          timestamp: new Date(),
        });
      }
      break;
    }

    case "available_commands_update":
    case "config_option_update":
    case "session_info_update":
    case "acp_status":
      break;

    default:
      console.log(`[ChatPanel] Unhandled sessionUpdate: ${kind}`);
      break;
  }
}

function processToolCallUpdate(
  update: Record<string, unknown>,
  arr: ChatMessage[],
  setFileChangesState: SetState<FileChangesState>
): void {
  const toolCallId = update.toolCallId as string | undefined;
  const status = update.status as string | undefined;
  const delegatedTaskId = update.delegatedTaskId as string | undefined;
  const toolKind = update.kind as string | undefined;
  const toolName = (update.title as string) ?? toolKind;
  const rawOutput = typeof update.rawOutput === "string" ? update.rawOutput : undefined;
  const rawInput = (typeof update.rawInput === "object" && update.rawInput !== null)
    ? update.rawInput as Record<string, unknown>
    : undefined;

  const outputParts: string[] = [];
  if (update.rawOutput) {
    outputParts.push(
      typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2)
    );
  }
  const toolContent = update.content as Array<{ type: string; text?: string }> | null | undefined;
  if (Array.isArray(toolContent)) {
    for (const c of toolContent) {
      if (c.text) outputParts.push(c.text);
    }
  }

  if (toolName && status === "completed") {
    const fileChange = extractFileChangeFromToolResult(toolName, rawOutput, rawInput);
    if (fileChange) {
      setFileChangesState((prev) => updateFileChange({ ...prev, files: new Map(prev.files) }, fileChange));
    }
  }

  if (toolCallId) {
    const idx = arr.findIndex((m) => m.toolCallId === toolCallId);
    if (idx >= 0) {
      const existing = arr[idx];
      arr[idx] = {
        ...existing,
        toolStatus: status ?? existing.toolStatus,
        toolName: toolName ?? existing.toolName,
        toolKind: toolKind ?? existing.toolKind,
        delegatedTaskId: delegatedTaskId ?? existing.delegatedTaskId,
        toolRawInput: rawInput ?? existing.toolRawInput,
        toolRawOutput: update.rawOutput ?? existing.toolRawOutput,
        content: outputParts.length
          ? `${existing.toolName ?? toolName ?? "tool"}\n\nOutput:\n${outputParts.join("\n")}`
          : existing.content,
      };
    } else {
      arr.push({
        id: uuidv4(),
        role: "tool",
        content: outputParts.join("\n") || `Tool ${status ?? "update"}`,
        timestamp: new Date(),
        toolStatus: status ?? "completed",
        toolCallId,
        toolName,
        toolKind,
        toolRawInput: rawInput,
        toolRawOutput: update.rawOutput,
        delegatedTaskId,
      });
    }
  }
}

function processTaskCompletion(
  update: Record<string, unknown>,
  arr: ChatMessage[],
  setFileChangesState: SetState<FileChangesState>
): void {
  const taskId = update.taskId as string | undefined;
  const completionSummary = update.completionSummary as string | undefined;
  const taskStatus = update.taskStatus as string | undefined;
  const filesModified = update.filesModified as string[] | undefined;

  if (filesModified && filesModified.length > 0) {
    const changes = extractFilesModified(filesModified);
    setFileChangesState((prev) => {
      let state = { ...prev, files: new Map(prev.files) };
      for (const change of changes) {
        state = updateFileChange(state, change);
      }
      return state;
    });
  }

  if (taskId) {
    const idx = arr.findIndex((m) => m.role === "tool" && m.delegatedTaskId === taskId);
    if (idx >= 0) {
      const existing = arr[idx];
      arr[idx] = {
        ...existing,
        toolStatus: taskStatus === "COMPLETED" || taskStatus === "completed" ? "completed" : "failed",
        completionSummary,
        content: completionSummary
          ? `${existing.toolName ?? "Task"}\n\n**Completed:**\n${completionSummary}`
          : existing.content,
      };
    }
  }
}

/**
 * Convert session history notifications to ChatMessage array
 */
export function processHistoryToMessages(
  history: AcpSessionNotification[],
  sessionId: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const streamingMsgId: Record<string, string | null> = {};
  const streamingThoughtId: Record<string, string | null> = {};
  let lastKind: string | null = null;

  for (const notification of history) {
    const update = (notification.update ?? notification) as Record<string, unknown>;
    const kind = update.sessionUpdate as string | undefined;
    if (!kind) continue;

    // Skip child agent updates
    const rawNotification = notification as Record<string, unknown>;
    const isChildAgentUpdate = !!(rawNotification.childAgentId ?? (update.childAgentId as unknown));
    if (isChildAgentUpdate) continue;

    const extractText = (): string => {
      const content = update.content as { type: string; text?: string } | undefined;
      if (content?.text) return content.text;
      if (typeof update.text === "string") return update.text;
      return "";
    };

    switch (kind) {
      case "agent_message_chunk": {
        const text = extractText();
        if (!text) break;
        streamingThoughtId[sessionId] = null;

        const shouldCreateNew = lastKind !== "agent_message_chunk";
        if (shouldCreateNew) {
          streamingMsgId[sessionId] = null;
        }

        let msgId = streamingMsgId[sessionId];
        if (!msgId) {
          msgId = uuidv4();
          streamingMsgId[sessionId] = msgId;
        }
        const idx = messages.findIndex((m) => m.id === msgId);
        if (idx >= 0) {
          messages[idx] = { ...messages[idx], content: messages[idx].content + text };
        } else {
          messages.push({ id: msgId, role: "assistant", content: text, timestamp: new Date() });
        }
        break;
      }

      case "agent_thought_chunk": {
        const text = extractText();
        if (!text) break;

        const shouldCreateNewThought = lastKind !== "agent_thought_chunk";
        if (shouldCreateNewThought) {
          streamingThoughtId[sessionId] = null;
        }

        let thoughtId = streamingThoughtId[sessionId];
        if (!thoughtId) {
          thoughtId = uuidv4();
          streamingThoughtId[sessionId] = thoughtId;
        }
        const idx = messages.findIndex((m) => m.id === thoughtId);
        if (idx >= 0) {
          messages[idx] = { ...messages[idx], content: messages[idx].content + text };
        } else {
          messages.push({ id: thoughtId, role: "thought", content: text, timestamp: new Date() });
        }
        break;
      }

      case "tool_call": {
        const toolCallId = update.toolCallId as string | undefined;
        const title = (update.title as string) ?? "tool";
        const status = (update.status as string) ?? "running";
        const toolKind = update.kind as string | undefined;
        const rawInput = (typeof update.rawInput === "object" && update.rawInput !== null)
          ? update.rawInput as Record<string, unknown>
          : undefined;
        const contentParts: string[] = [];
        if (update.rawInput) {
          contentParts.push(
            `Input:\n${typeof update.rawInput === "string" ? update.rawInput : JSON.stringify(update.rawInput, null, 2)}`
          );
        }
        const toolContent = update.content as Array<{ type: string; text?: string }> | undefined;
        if (Array.isArray(toolContent)) {
          for (const c of toolContent) {
            if (c.text) contentParts.push(c.text);
          }
        }
        const alreadyExists = toolCallId && messages.some((m) => m.toolCallId === toolCallId);
        if (!alreadyExists) {
          messages.push({
            id: toolCallId ?? uuidv4(),
            role: "tool",
            content: contentParts.join("\n\n") || title,
            timestamp: new Date(),
            toolName: title,
            toolStatus: status,
            toolCallId,
            toolKind,
            toolRawInput: rawInput,
          });
        }
        break;
      }

      case "tool_call_update": {
        const toolCallId = update.toolCallId as string | undefined;
        const status = update.status as string | undefined;
        const toolKind = update.kind as string | undefined;
        const toolName = (update.title as string) ?? toolKind;
        const rawInput = (typeof update.rawInput === "object" && update.rawInput !== null)
          ? update.rawInput as Record<string, unknown>
          : undefined;
        const delegatedTaskId = update.delegatedTaskId as string | undefined;

        const outputParts: string[] = [];
        if (update.rawOutput) {
          outputParts.push(
            typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2)
          );
        }
        const toolContent = update.content as Array<{ type: string; text?: string }> | null | undefined;
        if (Array.isArray(toolContent)) {
          for (const c of toolContent) {
            if (c.text) outputParts.push(c.text);
          }
        }

        if (toolCallId) {
          const idx = messages.findIndex((m) => m.toolCallId === toolCallId);
          if (idx >= 0) {
            const existing = messages[idx];
            messages[idx] = {
              ...existing,
              toolStatus: status ?? existing.toolStatus,
              toolName: toolName ?? existing.toolName,
              toolKind: toolKind ?? existing.toolKind,
              delegatedTaskId: delegatedTaskId ?? existing.delegatedTaskId,
              toolRawInput: rawInput ?? existing.toolRawInput,
              toolRawOutput: update.rawOutput ?? existing.toolRawOutput,
              content: outputParts.length
                ? `${existing.toolName ?? toolName ?? "tool"}\n\nOutput:\n${outputParts.join("\n")}`
                : existing.content,
            };
          } else {
            messages.push({
              id: uuidv4(),
              role: "tool",
              content: outputParts.join("\n") || `Tool ${status ?? "update"}`,
              timestamp: new Date(),
              toolStatus: status ?? "completed",
              toolCallId,
              toolName,
              toolKind,
              toolRawInput: rawInput,
              toolRawOutput: update.rawOutput,
              delegatedTaskId,
            });
          }
        }
        break;
      }

      case "plan": {
        const entries = update.entries as PlanEntry[] | undefined;
        const planText = entries
          ? entries.map((e) => `[${e.status ?? "pending"}] ${e.content}${e.priority ? ` (${e.priority})` : ""}`).join("\n")
          : typeof update.plan === "string" ? update.plan : JSON.stringify(update, null, 2);
        messages.push({ id: uuidv4(), role: "plan", content: planText, timestamp: new Date(), planEntries: entries });
        break;
      }

      default:
        // Skip other update types for history
        break;
    }

    lastKind = kind;
  }

  return messages;
}
