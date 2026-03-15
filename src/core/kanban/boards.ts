import { v4 as uuidv4 } from "uuid";
import {
  createKanbanBoard,
  DEFAULT_KANBAN_COLUMNS,
  type KanbanColumn,
  type KanbanColumnAutomation,
  type KanbanColumnStage,
} from "../models/kanban";
import type { RoutaSystem } from "../routa-system";

const RECOMMENDED_AUTOMATION_BY_STAGE: Partial<Record<KanbanColumnStage, KanbanColumnAutomation>> = {
  // Kanban lanes rely on custom specialist prompts. Avoid ROUTA here because
  // coordinator prompt injection overrides the lane specialist on first prompt.
  backlog: {
    enabled: true,
    role: "CRAFTER",
    specialistId: "kanban-backlog-refiner",
    specialistName: "Backlog Refiner",
    transitionType: "entry",
    autoAdvanceOnSuccess: false,
  },
  todo: {
    enabled: true,
    role: "CRAFTER",
    specialistId: "kanban-todo-orchestrator",
    specialistName: "Todo Orchestrator",
    transitionType: "entry",
    autoAdvanceOnSuccess: false,
  },
  dev: {
    enabled: true,
    role: "CRAFTER",
    specialistId: "kanban-dev-executor",
    specialistName: "Dev Crafter",
    transitionType: "entry",
    autoAdvanceOnSuccess: false,
  },
  review: {
    enabled: true,
    role: "GATE",
    specialistId: "kanban-review-guard",
    specialistName: "Review Guard",
    transitionType: "entry",
    autoAdvanceOnSuccess: false,
  },
  blocked: {
    enabled: true,
    role: "CRAFTER",
    specialistId: "kanban-blocked-resolver",
    specialistName: "Blocked Resolver",
    transitionType: "entry",
    autoAdvanceOnSuccess: false,
  },
  done: {
    enabled: true,
    role: "GATE",
    specialistId: "kanban-done-reporter",
    specialistName: "Done Reporter",
    transitionType: "entry",
    autoAdvanceOnSuccess: false,
  },
};

const LEGACY_SPECIALIST_IDS_BY_STAGE: Partial<Record<KanbanColumnStage, string[]>> = {
  backlog: ["issue-enricher", "kanban-workflow", "kanban-agent"],
  todo: ["routa", "developer", "kanban-workflow"],
  dev: ["pr-reviewer", "developer", "claude-code", "kanban-workflow"],
  review: ["desk-check", "gate", "pr-reviewer", "kanban-workflow"],
  blocked: ["claude-code", "developer", "routa", "kanban-workflow"],
  done: ["gate", "verifier", "claude-code", "kanban-workflow"],
};

export function applyRecommendedAutomationToColumns(columns: KanbanColumn[]): KanbanColumn[] {
  return columns.map((column) => {
    const recommended = RECOMMENDED_AUTOMATION_BY_STAGE[column.stage];
    const legacySpecialists = LEGACY_SPECIALIST_IDS_BY_STAGE[column.stage] ?? [];
    if (!recommended) {
      return { ...column };
    }

    if (!column.automation) {
      return {
        ...column,
        automation: { ...recommended },
      };
    }

    const shouldMigrateLegacySpecialist = Boolean(
      column.automation.specialistId && legacySpecialists.includes(column.automation.specialistId),
    );

    if ((column.automation.specialistId || column.automation.specialistName) && !shouldMigrateLegacySpecialist) {
      return {
        ...column,
        automation: { ...column.automation },
      };
    }

    return {
      ...column,
      automation: {
        ...recommended,
        ...column.automation,
        enabled: column.automation.enabled ?? recommended.enabled,
        providerId: column.automation.providerId ?? recommended.providerId,
        role: column.automation.role ?? recommended.role,
        specialistId: recommended.specialistId,
        specialistName: recommended.specialistName,
        transitionType: column.automation.transitionType ?? recommended.transitionType,
        requiredArtifacts: column.automation.requiredArtifacts,
        autoAdvanceOnSuccess: recommended.autoAdvanceOnSuccess,
      },
    };
  });
}

function createRecommendedDefaultColumns(): KanbanColumn[] {
  return applyRecommendedAutomationToColumns(DEFAULT_KANBAN_COLUMNS);
}

export async function ensureDefaultBoard(system: RoutaSystem, workspaceId: string): Promise<ReturnType<typeof createKanbanBoard>> {
  const existing = await system.kanbanBoardStore.getDefault(workspaceId);
  if (existing) {
    const normalizedColumns = applyRecommendedAutomationToColumns(existing.columns);
    if (JSON.stringify(normalizedColumns) !== JSON.stringify(existing.columns)) {
      const updated = {
        ...existing,
        columns: normalizedColumns,
        updatedAt: new Date(),
      };
      await system.kanbanBoardStore.save(updated);
      return updated;
    }
    return existing;
  }

  const workspace = await system.workspaceStore.get(workspaceId);
  const board = createKanbanBoard({
    id: uuidv4(),
    workspaceId,
    name: workspace?.title ? `${workspace.title} Board` : "Workspace Board",
    isDefault: true,
    columns: createRecommendedDefaultColumns(),
  });
  await system.kanbanBoardStore.save(board);
  await system.kanbanBoardStore.setDefault(workspaceId, board.id);
  return board;
}
