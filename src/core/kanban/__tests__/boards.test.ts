import { describe, expect, it } from "vitest";
import { DEFAULT_KANBAN_COLUMNS } from "@/core/models/kanban";
import { applyRecommendedAutomationToColumns } from "../boards";

describe("applyRecommendedAutomationToColumns", () => {
  it("applies lane-specific specialists to a bare default board", () => {
    const columns = applyRecommendedAutomationToColumns(DEFAULT_KANBAN_COLUMNS);

    expect(columns.map((column) => column.automation?.specialistId)).toEqual([
      "kanban-backlog-refiner",
      "kanban-todo-orchestrator",
      "kanban-dev-executor",
      "kanban-review-guard",
      "kanban-blocked-resolver",
      "kanban-done-reporter",
    ]);
    expect(columns.map((column) => column.automation?.role)).toEqual([
      "CRAFTER",
      "CRAFTER",
      "CRAFTER",
      "GATE",
      "CRAFTER",
      "GATE",
    ]);
    expect(columns.every((column) => column.automation?.autoAdvanceOnSuccess === false)).toBe(true);
  });

  it("backfills legacy lane automation without keeping system auto-advance", () => {
    const columns = applyRecommendedAutomationToColumns([
      {
        ...DEFAULT_KANBAN_COLUMNS[0],
        automation: {
          enabled: true,
          autoAdvanceOnSuccess: true,
        },
      },
      ...DEFAULT_KANBAN_COLUMNS.slice(1),
    ]);

    expect(columns[0].automation?.specialistId).toBe("kanban-backlog-refiner");
    expect(columns[0].automation?.autoAdvanceOnSuccess).toBe(false);
  });

  it("preserves a customized lane specialist", () => {
    const columns = applyRecommendedAutomationToColumns([
      {
        ...DEFAULT_KANBAN_COLUMNS[2],
        automation: {
          enabled: true,
          role: "DEVELOPER",
          specialistId: "custom-dev-sweeper",
          specialistName: "Custom Dev Sweeper",
          autoAdvanceOnSuccess: true,
        },
      },
    ]);

    expect(columns[0].automation?.specialistId).toBe("custom-dev-sweeper");
    expect(columns[0].automation?.autoAdvanceOnSuccess).toBe(true);
  });
});
