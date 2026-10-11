import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId } from "@t3tools/contracts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

describe("ThreadPlanProgress", () => {
  it("tracks the in-progress step and clears when the plan completes", () => {
    const progress = ThreadPlanProgress.make();
    const threadId = "t-plan-1";
    progress.recordPlanProgress(threadId, [
      { step: "Audit failure paths", status: "completed" },
      { step: "Implement the fix", status: "inProgress" },
      { step: "Run targeted tests", status: "pending" },
    ]);
    expect(progress.getThreadPlanProgress(threadId)).toEqual({
      step: "Implement the fix",
      completedSteps: 1,
      totalSteps: 3,
    });

    progress.recordPlanProgress(threadId, [
      { step: "Audit failure paths", status: "completed" },
      { step: "Implement the fix", status: "completed" },
      { step: "Run targeted tests", status: "completed" },
    ]);
    expect(progress.getThreadPlanProgress(threadId)).toBeNull();
  });

  it("falls back to the first non-completed step when nothing is in progress", () => {
    const progress = ThreadPlanProgress.make();
    const threadId = "t-plan-2";
    progress.recordPlanProgress(threadId, [
      { step: "First", status: "pending" },
      { step: "Second", status: "pending" },
    ]);
    expect(progress.getThreadPlanProgress(threadId)?.step).toBe("First");
  });

  it("clearThreadPlanProgress removes the entry (turn settled / session died)", () => {
    const progress = ThreadPlanProgress.make();
    const threadId = "t-plan-3";
    progress.recordPlanProgress(threadId, [{ step: "Only step", status: "inProgress" }]);
    progress.clearThreadPlanProgress(threadId);
    expect(progress.getThreadPlanProgress(threadId)).toBeNull();
  });

  it("keeps the running turn's latest step small, and clears it with the plan", () => {
    const progress = ThreadPlanProgress.make();
    const threadId = "t-plan-4";
    progress.recordLiveActivity(threadId, {
      id: EventId.make("activity-1"),
      tone: "tool",
      kind: "tool.updated",
      summary: "File edited",
      payload: {
        data: { toolName: "Edit", input: { file_path: "a.ts", new_string: "x".repeat(5000) } },
      },
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const payload = progress.getThreadLiveActivity(threadId)?.payload as {
      data: { input: { file_path: string; new_string: string } };
    };
    expect(payload.data.input.file_path).toBe("a.ts");
    expect(payload.data.input.new_string.length).toBeLessThanOrEqual(200);
    progress.clearThreadPlanProgress(threadId);
    expect(progress.getThreadLiveActivity(threadId)).toBeNull();
  });

  it("leaves dropped parts out of the step, so it stays valid JSON", () => {
    const progress = ThreadPlanProgress.make();
    const threadId = "t-plan-5";
    progress.recordLiveActivity(threadId, {
      id: EventId.make("activity-2"),
      tone: "tool",
      kind: "tool.updated",
      summary: "Tool call",
      payload: {
        data: {
          toolName: "AskUserQuestion",
          input: { questions: [{ question: "Which phone?" }], skip: undefined },
        },
      },
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const payload = progress.getThreadLiveActivity(threadId)?.payload;
    expect(payload).toEqual({
      data: { toolName: "AskUserQuestion", input: { questions: [] } },
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
