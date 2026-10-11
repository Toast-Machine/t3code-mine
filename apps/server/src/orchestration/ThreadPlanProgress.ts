/**
 * ThreadPlanProgressService - in-memory per-thread plan progress for the
 * Working indicators (sidebar rows, in-chat working line).
 *
 * Plans are a progress annotation, not a surface of their own: the useful
 * kernel of a turn.plan.updated event is "which step is the agent on right
 * now". Ingestion records the current step here and the shell query reads it
 * at mapping time — no persistence, no migration (same pattern as
 * ThreadBackgroundLivenessService). Cleared when the turn settles or the
 * session dies, so a finished plan never lingers as stale UI.
 *
 * @module ThreadPlanProgressService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface ThreadPlanProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

interface PlanStepInput {
  readonly step: string;
  readonly status: string;
}

export class ThreadPlanProgressService extends Context.Service<
  ThreadPlanProgressService,
  {
    /**
     * Feed one turn.plan.updated payload. An all-completed plan clears the
     * entry (the turn is wrapping up; nothing is "in progress" anymore).
     */
    readonly recordPlanProgress: (threadId: string, plan: ReadonlyArray<PlanStepInput>) => void;

    /** Turn settled or session died: the working indicator reverts to plain. */
    readonly clearThreadPlanProgress: (threadId: string) => void;

    readonly getThreadPlanProgress: (threadId: string) => ThreadPlanProgress | null;

    /**
     * Personal build: the running turn's latest tool step, so the sidebar can
     * say "Running git" instead of a bare "Working". Cleared with the plan.
     */
    readonly recordLiveActivity: (threadId: string, activity: OrchestrationThreadActivity) => void;

    readonly getThreadLiveActivity: (threadId: string) => OrchestrationThreadActivity | null;
  }
>()("t3/orchestration/ThreadPlanProgress/ThreadPlanProgressService") {}

export function make(): ThreadPlanProgressService["Service"] {
  const progressByThreadId = new Map<string, ThreadPlanProgress>();
  const liveActivityByThreadId = new Map<string, OrchestrationThreadActivity>();

  return {
    recordPlanProgress: (threadId, plan) => {
      const totalSteps = plan.length;
      const completedSteps = plan.filter((step) => step.status === "completed").length;
      // Current step: the in-progress one, else the first pending one (a
      // plan that was just written has no in-progress step yet).
      const current =
        plan.find((step) => step.status === "inProgress") ??
        plan.find((step) => step.status !== "completed");
      if (totalSteps === 0 || completedSteps === totalSteps || current === undefined) {
        progressByThreadId.delete(threadId);
        return;
      }
      progressByThreadId.set(threadId, {
        step: current.step,
        completedSteps,
        totalSteps,
      });
    },

    clearThreadPlanProgress: (threadId) => {
      progressByThreadId.delete(threadId);
      liveActivityByThreadId.delete(threadId);
    },

    getThreadPlanProgress: (threadId) => progressByThreadId.get(threadId) ?? null,

    recordLiveActivity: (threadId, activity) => {
      liveActivityByThreadId.set(threadId, { ...activity, payload: trimPayload(activity.payload) });
    },

    getThreadLiveActivity: (threadId) => liveActivityByThreadId.get(threadId) ?? null,
  };
}

// The sidebar only needs a step's name and target, but tool payloads carry
// whole file bodies and outputs. Every shell push sends this, so long strings
// are cut and deep structures dropped. Dropped values are left out, never
// `undefined`: the client decodes the payload as JSON, and one `undefined`
// fails the whole shell stream.
const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 4;

const isKept = (value: unknown) => value !== undefined;

function trimPayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object" || depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 8)
      .map((item) => trimPayload(item, depth + 1))
      .filter(isKept);
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, trimPayload(item, depth + 1)] as const)
      .filter(([, item]) => isKept(item)),
  );
}

export const layer = Layer.effect(ThreadPlanProgressService, Effect.sync(make));
