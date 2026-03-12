"use client";

import React, { useState } from "react";
import { RepoPicker } from "@/client/components/repo-picker";
import type { RepoSelection } from "@/client/components/repo-picker";

interface CodebaseInfo {
  id: string;
  label?: string;
  repoPath: string;
  isDefault?: boolean;
}

interface WorkspaceSettingsTabProps {
  workspaceId: string;
  codebases: CodebaseInfo[];
  fetchCodebases: () => Promise<void>;
  worktreeRootDraft: string;
  setWorktreeRootDraft: (v: string) => void;
  worktreeRootState: { saving: boolean; message: string | null; error: string | null };
  displayedWorktreeRoot: string;
  defaultWorktreeRootHint: string;
  onSaveWorktreeRoot: () => Promise<void>;
}

export function WorkspaceSettingsTab({
  workspaceId,
  codebases,
  fetchCodebases,
  worktreeRootDraft,
  setWorktreeRootDraft,
  worktreeRootState,
  displayedWorktreeRoot,
  defaultWorktreeRootHint,
  onSaveWorktreeRoot,
}: WorkspaceSettingsTabProps) {
  const [repoPickerValue, setRepoPickerValue] = useState<RepoSelection | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [editingCodebase, setEditingCodebase] = useState<CodebaseInfo | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editRepoPath, setEditRepoPath] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const handlePickerChange = async (selection: RepoSelection | null) => {
    if (!selection) return;
    setAddError(null);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/codebases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: selection.path, branch: selection.branch, label: selection.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add repository");
      await fetchCodebases();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add repository");
    }
    // Always reset so the picker returns to "Add" state
    setRepoPickerValue(null);
  };

  const handleRemove = async (codebaseId: string) => {
    try {
      await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/codebases/${encodeURIComponent(codebaseId)}`,
        { method: "DELETE" }
      );
      await fetchCodebases();
    } catch {
      // ignore
    }
  };

  const handleEdit = (cb: CodebaseInfo) => {
    setEditingCodebase(cb);
    setEditLabel(cb.label ?? "");
    setEditRepoPath(cb.repoPath);
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingCodebase) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/codebases/${encodeURIComponent(editingCodebase.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: editLabel, repoPath: editRepoPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update repository");
      await fetchCodebases();
      setEditingCodebase(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update repository");
    } finally {
      setEditSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingCodebase(null);
    setEditError(null);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* ── Linked Repositories ─────────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Linked Repositories
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Repositories linked to this workspace can be selected when creating Kanban tasks.
          No selection on a task means all linked repos are included.
        </p>

        {codebases.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {codebases.map((cb) => (
              <span
                key={cb.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#0d1018] px-2.5 py-1 text-xs text-gray-700 dark:text-gray-300"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                <span className="max-w-50 truncate">{cb.label ?? cb.repoPath.split("/").pop() ?? cb.repoPath}</span>
                <span className="text-[10px] text-gray-400 truncate max-w-40">{cb.repoPath}</span>
                {cb.isDefault && (
                  <span className="text-[10px] text-amber-500 font-medium">default</span>
                )}
                <button
                  onClick={() => handleEdit(cb)}
                  className="ml-0.5 w-4 h-4 flex items-center justify-center rounded text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors"
                  title={`Edit ${cb.label ?? cb.repoPath}`}
                >
                  ✎
                </button>
                <button
                  onClick={() => void handleRemove(cb.id)}
                  className="w-4 h-4 flex items-center justify-center rounded text-gray-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                  title={`Remove ${cb.label ?? cb.repoPath}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {codebases.length === 0 && (
          <div className="mb-3 text-xs text-gray-400 dark:text-gray-500 italic">
            No repositories linked yet.
          </div>
        )}

        {/* RepoPicker for selecting / cloning a repo to link */}
        <div className="flex items-center gap-2">
          <div className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Add:</div>
          <RepoPicker value={repoPickerValue} onChange={(sel) => void handlePickerChange(sel)} />
        </div>
        {addError && (
          <div className="mt-2 text-xs text-rose-600 dark:text-rose-400">{addError}</div>
        )}
      </section>

      <hr className="border-gray-100 dark:border-[#1c1f2e]" />

      {/* ── Worktree Root Override ───────────────────────────────── */}
      <section data-testid="workspace-worktree-settings">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Worktree Root Override
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          You do not need to configure this for the normal flow. By default, this workspace uses{" "}
          <code className="font-mono text-gray-600 dark:text-gray-300">{defaultWorktreeRootHint}</code>.
          Only set a custom path if you want to override that location.
        </p>
        <div className="flex gap-2 items-start">
          <div className="flex-1">
            <input
              value={worktreeRootDraft}
              onChange={(e) => setWorktreeRootDraft(e.target.value)}
              placeholder={defaultWorktreeRootHint}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-gray-700 outline-none focus:border-amber-400 dark:border-gray-700 dark:bg-[#0d1018] dark:text-gray-200 font-mono text-xs"
              data-testid="worktree-root-input"
            />
            <div className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">
              Effective path:{" "}
              <code className="font-mono">{displayedWorktreeRoot}</code>
            </div>
            {worktreeRootState.error && (
              <div className="mt-1.5 text-xs text-rose-600 dark:text-rose-400" data-testid="worktree-root-error">
                {worktreeRootState.error}
              </div>
            )}
            {worktreeRootState.message && (
              <div className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                {worktreeRootState.message}
              </div>
            )}
          </div>
          <button
            onClick={() => void onSaveWorktreeRoot()}
            disabled={worktreeRootState.saving}
            className="shrink-0 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="save-worktree-root"
          >
            {worktreeRootState.saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {/* ── Edit Codebase Modal ───────────────────────────────────── */}
      {editingCodebase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-[#1c1f2e] dark:bg-[#12141c]">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Edit Repository
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Label
                </label>
                <input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  placeholder="e.g. routa-js"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-amber-400 dark:border-gray-700 dark:bg-[#0d1018] dark:text-gray-200"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Repository Path
                </label>
                <input
                  value={editRepoPath}
                  onChange={(e) => setEditRepoPath(e.target.value)}
                  placeholder="/path/to/repo"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-mono text-gray-700 outline-none focus:border-amber-400 dark:border-gray-700 dark:bg-[#0d1018] dark:text-gray-200"
                />
              </div>
              {editError && (
                <div className="text-xs text-rose-600 dark:text-rose-400">{editError}</div>
              )}
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button
                onClick={handleCancelEdit}
                disabled={editSaving}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-[#191c28]"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSaveEdit()}
                disabled={editSaving}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-60"
              >
                {editSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
