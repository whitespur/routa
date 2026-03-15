"use client";

import { useMemo, useState } from "react";
import { CodeBlock } from "./code-block";
import { CodeRetrievalViewer } from "./code-retrieval-viewer";
import { FileOutputViewer, parseFileOutput } from "./file-output-viewer";
import { MarkdownViewer } from "./markdown/markdown-viewer";

function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [collapsed, setCollapsed] = useState(depth > 1);

  if (value === null) return <span className="text-gray-400 dark:text-gray-500">null</span>;
  if (typeof value === "boolean") {
    return <span className="text-yellow-600 dark:text-yellow-400">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  }
  if (typeof value === "string") {
    return (
      <span className="text-green-700 dark:text-green-400">
        &quot;{value}&quot;
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-500">[]</span>;
    return (
      <span>
        <button
          onClick={() => setCollapsed((current) => !current)}
          className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-mono"
        >
          {collapsed ? `[…${value.length}]` : "["}
        </button>
        {!collapsed && (
          <>
            <div className="pl-3 border-l border-gray-200 dark:border-gray-700 ml-1">
              {value.map((item, index) => (
                <div key={index} className="my-0.5">
                  <span className="text-gray-400 dark:text-gray-500 select-none">{index}: </span>
                  <JsonNode value={item} depth={depth + 1} />
                  {index < value.length - 1 && <span className="text-gray-400">,</span>}
                </div>
              ))}
            </div>
            <span className="text-gray-500">]</span>
          </>
        )}
      </span>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-gray-500">{"{}"}</span>;
    return (
      <span>
        <button
          onClick={() => setCollapsed((current) => !current)}
          className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-mono"
        >
          {collapsed ? `{…${entries.length}}` : "{"}
        </button>
        {!collapsed && (
          <>
            <div className="pl-3 border-l border-gray-200 dark:border-gray-700 ml-1">
              {entries.map(([key, nestedValue], index) => (
                <div key={key} className="my-0.5">
                  <span className="text-purple-700 dark:text-purple-400 font-semibold">&quot;{key}&quot;</span>
                  <span className="text-gray-500">: </span>
                  <JsonNode value={nestedValue} depth={depth + 1} />
                  {index < entries.length - 1 && <span className="text-gray-400">,</span>}
                </div>
              ))}
            </div>
            <span className="text-gray-500">{"}"}</span>
          </>
        )}
      </span>
    );
  }

  return <span className="text-gray-700 dark:text-gray-300">{String(value)}</span>;
}

export function tryParseJsonString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function summarizeToolOutput(output: unknown): string {
  if (output == null) return "";

  if (typeof output === "string") {
    const parsed = tryParseJsonString(output);
    if (parsed != null) return summarizeToolOutput(parsed);

    const condensed = output.replace(/\s+/g, " ").trim();
    return condensed.length > 72 ? `${condensed.slice(0, 72)}…` : condensed;
  }

  if (Array.isArray(output)) {
    return `JSON array · ${output.length} items`;
  }

  if (typeof output === "object") {
    return `JSON object · ${Object.keys(output as Record<string, unknown>).length} keys`;
  }

  return String(output);
}

function normalizeOutput(output: unknown): { text: string; parsed: unknown | null } | null {
  if (output == null) return null;

  if (typeof output === "string") {
    return {
      text: output,
      parsed: tryParseJsonString(output),
    };
  }

  return {
    text: JSON.stringify(output, null, 2),
    parsed: output,
  };
}

export function ToolOutputView({
  output,
  toolName,
}: {
  output: unknown;
  toolName?: string;
}) {
  const normalized = useMemo(() => normalizeOutput(output), [output]);
  const [mode, setMode] = useState<"tree" | "raw" | "code">("code");
  const [richTextExpanded, setRichTextExpanded] = useState(false);
  const text = normalized?.text ?? "";
  const parsed = normalized?.parsed ?? null;
  const isLarge = text.length > 500;

  const isCodebaseRetrievalFormat = (() => {
    if (
      parsed &&
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed[0]?.type === "text" &&
      typeof parsed[0]?.text === "string" &&
      parsed[0].text.includes("Path:") &&
      parsed[0].text.includes("code sections")
    ) {
      return true;
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const outputField = (parsed as Record<string, unknown>).output;
      if (
        typeof outputField === "string" &&
        outputField.includes("Path:") &&
        outputField.includes("code sections")
      ) {
        return true;
      }
    }

    return toolName === "codebase-retrieval" && text.includes("Path:");
  })();

  const codeRetrievalContent = useMemo(() => {
    if (!isCodebaseRetrievalFormat) return text;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const outputField = (parsed as Record<string, unknown>).output;
      if (typeof outputField === "string") {
        return outputField;
      }
    }

    return text;
  }, [isCodebaseRetrievalFormat, parsed, text]);

  const innerOutput = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "output" in parsed
    ? (parsed as Record<string, unknown>).output
    : null;

  const richTextContent = typeof innerOutput === "string" ? innerOutput : text;

  const isRichTextContent = useMemo(() => {
    if (!richTextContent || richTextContent.length < 200) return false;

    const newlineCount = (richTextContent.match(/\n/g) || []).length;
    if (newlineCount < 10) return false;

    const hasMarkdownHeaders = /^#{1,6}\s+/m.test(richTextContent);
    const hasMarkdownLinks = /\[.+?\]\(.+?\)/.test(richTextContent);
    const hasMarkdownLists = /^[\s]*[-*+]\s+/m.test(richTextContent);
    const hasMarkdownBold = /\*\*[^*]+\*\*/.test(richTextContent);
    const hasHtmlTags = /<[a-z][^>]*>/i.test(richTextContent);

    const markdownScore = [
      hasMarkdownHeaders,
      hasMarkdownLinks,
      hasMarkdownLists,
      hasMarkdownBold,
      hasHtmlTags,
    ].filter(Boolean).length;

    if (toolName === "web-fetch" || toolName === "fetch") {
      return newlineCount >= 5;
    }

    return markdownScore >= 2 || (newlineCount > 30 && markdownScore >= 1);
  }, [richTextContent, toolName]);

  const normalizedToolName = toolName?.toLowerCase();
  const isSearchTool = normalizedToolName === "search" || normalizedToolName === "grep";
  const isReadTool =
    normalizedToolName === "read" ||
    normalizedToolName === "read-file" ||
    normalizedToolName === "view";

  if (!normalized) return null;

  if (isCodebaseRetrievalFormat) {
    return (
      <div>
        <div className="px-2 py-1 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700/60 flex items-center justify-between">
          <span className="text-[9px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            Output (Code Sections)
          </span>
        </div>
        <div className="p-2">
          <CodeRetrievalViewer output={codeRetrievalContent} initiallyExpanded={true} />
        </div>
      </div>
    );
  }

  if (isRichTextContent && !isCodebaseRetrievalFormat) {
    return (
      <div>
        <div className="px-2 py-1 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700/60 flex items-center justify-between">
          <button
            onClick={() => setRichTextExpanded((current) => !current)}
            className="flex items-center gap-1.5 text-[9px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg
              className={`w-3 h-3 transition-transform ${richTextExpanded ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Output (Rendered)
          </button>
          <span className="text-[9px] text-gray-400 dark:text-gray-500">{richTextContent.length} chars</span>
        </div>
        {richTextExpanded ? (
          <div className="p-3 max-h-[500px] overflow-y-auto bg-white dark:bg-gray-900/40">
            <MarkdownViewer
              content={richTextContent}
              className="text-xs prose prose-sm dark:prose-invert max-w-none"
            />
          </div>
        ) : (
          <div
            onClick={() => setRichTextExpanded(true)}
            className="px-3 py-2 text-[10px] text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40 line-clamp-3"
          >
            {richTextContent.slice(0, 200).replace(/\n/g, " ")}
            {richTextContent.length > 200 && "…"}
          </div>
        )}
      </div>
    );
  }

  if ((isSearchTool || isReadTool) && typeof innerOutput === "string") {
    const fileOutputParsed = parseFileOutput(innerOutput, isSearchTool ? "search" : "read");
    if (fileOutputParsed.kind !== "unknown") {
      const label = isSearchTool
        ? `Search Results (${fileOutputParsed.matchCount ?? fileOutputParsed.searchMatches?.length ?? 0} matches)`
        : "File Content";

      return (
        <div>
          <div className="px-2 py-1 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700/60 flex items-center justify-between">
            <span className="text-[9px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
              {label}
            </span>
          </div>
          <div className="p-2">
            <FileOutputViewer
              output={innerOutput}
              toolName={isSearchTool ? "search" : "read"}
              initiallyExpanded={true}
            />
          </div>
        </div>
      );
    }
  }

  if (!parsed) {
    return (
      <div>
        <div className="px-2 py-1 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700/60 flex items-center justify-between">
          <span className="text-[9px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            Output
          </span>
          {isLarge && <span className="text-[9px] text-gray-400 dark:text-gray-500">{text.length} chars</span>}
        </div>
        <CodeBlock
          content={text}
          language="auto"
          variant="simple"
          className="!border-0 !rounded-none"
          wordWrap={true}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="px-2 py-1 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700/60 flex items-center justify-between">
        <span className="text-[9px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
          Output (JSON)
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => setMode("code")}
            className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
              mode === "code"
                ? "bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300"
                : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            }`}
          >
            Code
          </button>
          <button
            onClick={() => setMode("tree")}
            className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
              mode === "tree"
                ? "bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300"
                : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            }`}
          >
            Tree
          </button>
          <button
            onClick={() => setMode("raw")}
            className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
              mode === "raw"
                ? "bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300"
                : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            }`}
          >
            Raw
          </button>
        </div>
      </div>
      {mode === "tree" ? (
        <div className="px-2 py-1.5 text-[10px] font-mono bg-white dark:bg-gray-900/40 overflow-auto">
          <JsonNode value={parsed} depth={0} />
        </div>
      ) : mode === "code" ? (
        <CodeBlock
          content={JSON.stringify(parsed, null, 2)}
          language="json"
          variant={isLarge ? "rich" : "simple"}
          className="!border-0 !rounded-none"
          wordWrap={true}
          showHeader={false}
        />
      ) : (
        <pre className="px-2 py-1.5 text-[10px] font-mono text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words bg-white dark:bg-gray-900/40">
          {text}
        </pre>
      )}
    </div>
  );
}

export function ToolInputTable({ input }: { input: unknown }) {
  if (input == null) return null;

  if (typeof input === "object" && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return null;

    return (
      <table className="w-full text-[10px] border-collapse">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="border-b border-gray-100 dark:border-gray-700/50 last:border-0">
              <td className="py-1 pr-3 font-mono font-semibold text-gray-500 dark:text-gray-400 align-top whitespace-nowrap w-px">
                {key}
              </td>
              <td className="py-1 font-mono text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-all">
                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <pre className="text-[10px] text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}
