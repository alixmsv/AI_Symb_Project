import {
  Issue,
  IssueType,
  Procedure,
  ProcedureStep,
  RunEvent,
  RunEventKind,
  RunState,
  RunStatus,
  Severity,
  Source,
  StepStatus,
  StepUpdateStatus,
  ToolResult,
} from "./types";

/**
 * The rule engine of the assembly monitor.
 *
 * Everything here is a pure function: it takes the current run and returns a
 * new one. The AI only *reports* what it sees; these rules decide what that
 * means for the checklist (for example, that finishing step 4 while step 2 is
 * still open means step 2 was skipped). That keeps the important checks
 * deterministic instead of leaving them to the model.
 */

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

const MAX_EVENTS = 500;

export function createRun(procedure: Procedure): RunState {
  const stepStatus: Record<string, StepStatus> = {};
  procedure.steps.forEach((s) => {
    stepStatus[s.id] = "pending";
  });
  return {
    procedureId: procedure.id,
    stepStatus,
    stepTimes: {},
    issues: [],
    events: [],
    startedAt: null,
    completedAt: null,
    lastObservation: null,
    seq: 0,
  };
}

function copy(state: RunState): RunState {
  return {
    ...state,
    stepStatus: { ...state.stepStatus },
    stepTimes: { ...state.stepTimes },
    issues: state.issues.map((i) => ({ ...i })),
    events: [...state.events],
  };
}

function addEvent(
  state: RunState,
  now: number,
  kind: RunEventKind,
  text: string,
  source: Source,
  extra: { stepId?: string; issueId?: string } = {}
) {
  state.seq += 1;
  const event: RunEvent = {
    id: `e${state.seq}`,
    t: now,
    kind,
    text,
    source,
    ...extra,
  };
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}

function ensureStarted(state: RunState, now: number) {
  if (state.startedAt === null) {
    state.startedAt = now;
    addEvent(state, now, "run_started", "Run started", "system");
  }
}

function findStep(procedure: Procedure, stepId: string) {
  const wanted = stepId.trim().toLowerCase();
  const index = procedure.steps.findIndex(
    (s) => s.id.toLowerCase() === wanted
  );
  return index === -1 ? null : { step: procedure.steps[index], index };
}

function label(step: ProcedureStep) {
  return `${step.id} "${step.title}"`;
}

export function openIssues(state: RunState): Issue[] {
  return state.issues.filter((i) => i.resolvedAt === undefined);
}

/** The most severe unresolved issue, newest first among equals. */
export function topIssue(state: RunState): Issue | null {
  const open = openIssues(state);
  if (open.length === 0) {
    return null;
  }
  return open.reduce((best, issue) =>
    SEVERITY_RANK[issue.severity] > SEVERITY_RANK[best.severity] ||
    (SEVERITY_RANK[issue.severity] === SEVERITY_RANK[best.severity] &&
      issue.raisedAt >= best.raisedAt)
      ? issue
      : best
  );
}

/** First step in procedure order that still needs doing. */
export function nextExpectedStep(
  procedure: Procedure,
  state: RunState
): ProcedureStep | null {
  return (
    procedure.steps.find(
      (s) => !s.optional && state.stepStatus[s.id] !== "done"
    ) ?? null
  );
}

export function progress(procedure: Procedure, state: RunState) {
  const required = procedure.steps.filter((s) => !s.optional);
  const done = required.filter((s) => state.stepStatus[s.id] === "done");
  return { done: done.length, total: required.length };
}

export function runStatus(state: RunState): RunStatus {
  const needsAttention = openIssues(state).some(
    (i) => SEVERITY_RANK[i.severity] >= SEVERITY_RANK.warning
  );
  if (needsAttention) {
    return "attention";
  }
  if (state.completedAt !== null) {
    return "completed";
  }
  return state.startedAt === null ? "idle" : "running";
}

function updateCompletion(procedure: Procedure, state: RunState, now: number) {
  const { done, total } = progress(procedure, state);
  const complete = total > 0 && done === total;
  if (complete && state.completedAt === null) {
    state.completedAt = now;
    addEvent(state, now, "run_completed", "All steps completed", "system");
  } else if (!complete && state.completedAt !== null) {
    state.completedAt = null;
  }
}

function resolveInPlace(
  state: RunState,
  issue: Issue,
  resolution: "fixed" | "dismissed",
  source: Source,
  now: number
) {
  issue.resolvedAt = now;
  issue.resolution = resolution;
  addEvent(
    state,
    now,
    "issue_resolved",
    `${resolution === "fixed" ? "Fixed" : "Dismissed"}: ${issue.message}`,
    source,
    { issueId: issue.id, stepId: issue.stepId ?? undefined }
  );
}

function raiseInPlace(
  state: RunState,
  now: number,
  input: {
    stepId: string | null;
    type: IssueType;
    severity: Severity;
    message: string;
    suggestedFix?: string;
    source: Source;
  }
): { issue: Issue; isNew: boolean } {
  // The AI looks at the scene every few seconds and would otherwise report the
  // same problem again and again. One open issue per (type, step) is enough.
  const existing = state.issues.find(
    (i) =>
      i.resolvedAt === undefined &&
      i.type === input.type &&
      i.stepId === input.stepId
  );
  if (existing) {
    existing.message = input.message;
    existing.suggestedFix = input.suggestedFix ?? existing.suggestedFix;
    if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = input.severity;
    }
    return { issue: existing, isNew: false };
  }
  state.seq += 1;
  const issue: Issue = {
    id: `I${state.seq}`,
    stepId: input.stepId,
    type: input.type,
    severity: input.severity,
    message: input.message,
    suggestedFix: input.suggestedFix,
    source: input.source,
    raisedAt: now,
  };
  state.issues.push(issue);
  addEvent(state, now, "issue_raised", input.message, input.source, {
    issueId: issue.id,
    stepId: input.stepId ?? undefined,
  });
  return { issue, isNew: true };
}

/** Marks the run as started (called when the AI session goes live). */
export function startRun(state: RunState, now: number): RunState {
  if (state.startedAt !== null) {
    return state;
  }
  const next = copy(state);
  ensureStarted(next, now);
  return next;
}

/**
 * Applies a step report ("this step started / finished / was undone") and
 * runs the ordering rules on it.
 */
export function applyStepUpdate(
  procedure: Procedure,
  state: RunState,
  input: {
    stepId: string;
    status: StepUpdateStatus;
    observation?: string;
    source: Source;
  },
  now: number
): { state: RunState; result: ToolResult } {
  const found = findStep(procedure, input.stepId);
  if (!found) {
    return {
      state,
      result: {
        ok: false,
        message: `Unknown step_id "${input.stepId}". Valid ids: ${procedure.steps
          .map((s) => s.id)
          .join(", ")}.`,
        state: summarizeState(procedure, state),
      },
    };
  }
  const { step, index } = found;
  const next = copy(state);
  const current = next.stepStatus[step.id];
  const earlierUnfinished = procedure.steps
    .slice(0, index)
    .filter((s) => !s.optional && next.stepStatus[s.id] !== "done");
  let message: string;

  if (input.observation) {
    next.lastObservation = input.observation;
  }

  if (input.status === "not_done") {
    if (current === "pending") {
      message = `${label(step)} was already not done.`;
    } else {
      next.stepStatus[step.id] = "pending";
      next.stepTimes[step.id] = {};
      addEvent(next, now, "step_reset", `${step.title} reopened`, input.source, {
        stepId: step.id,
      });
      message = `${label(step)} is open again.`;
    }
  } else if (current === "done") {
    message = `${label(step)} was already completed. Use status "not_done" only if it has been undone.`;
  } else if (input.status === "in_progress") {
    ensureStarted(next, now);
    if (current !== "in_progress") {
      // Only one step is worked on at a time.
      procedure.steps.forEach((s) => {
        if (next.stepStatus[s.id] === "in_progress") {
          next.stepStatus[s.id] = "pending";
        }
      });
      next.stepStatus[step.id] = "in_progress";
      next.stepTimes[step.id] = {
        ...next.stepTimes[step.id],
        startedAt: next.stepTimes[step.id]?.startedAt ?? now,
      };
      addEvent(next, now, "step_started", `${step.title} started`, input.source, {
        stepId: step.id,
      });
    }
    message = `${label(step)} is in progress.`;
    const notYetFlagged = earlierUnfinished.filter(
      (s) => next.stepStatus[s.id] !== "skipped"
    );
    if (notYetFlagged.length > 0) {
      const names = notYetFlagged.map((s) => `"${s.title}"`).join(", ");
      raiseInPlace(next, now, {
        stepId: step.id,
        type: "wrong_order",
        severity: "warning",
        message: `"${step.title}" was started before ${names}.`,
        suggestedFix: `Do "${notYetFlagged[0].title}" first: ${notYetFlagged[0].instruction}`,
        source: "system",
      });
      message += ` Out of order: ${notYetFlagged
        .map(label)
        .join(", ")} not completed yet. Warn the operator in one short sentence.`;
    }
  } else {
    // completed
    ensureStarted(next, now);
    // A skip is raised once, when it happens. Later steps do not repeat it.
    const newlySkipped = earlierUnfinished.filter(
      (s) => next.stepStatus[s.id] !== "skipped"
    );
    newlySkipped.forEach((s) => {
      next.stepStatus[s.id] = "skipped";
      addEvent(next, now, "step_skipped", `${s.title} skipped`, "system", {
        stepId: s.id,
      });
      raiseInPlace(next, now, {
        stepId: s.id,
        type: "skipped_step",
        severity: s.critical ? "critical" : "warning",
        message: `"${s.title}" was skipped before "${step.title}".`,
        suggestedFix: `Go back and do it: ${s.instruction}`,
        source: "system",
      });
    });
    next.stepStatus[step.id] = "done";
    next.stepTimes[step.id] = {
      startedAt: next.stepTimes[step.id]?.startedAt ?? now,
      completedAt: now,
    };
    addEvent(next, now, "step_completed", `${step.title} completed`, input.source, {
      stepId: step.id,
    });
    // Finishing a step settles whatever was open against it.
    next.issues
      .filter((i) => i.resolvedAt === undefined && i.stepId === step.id)
      .forEach((i) => resolveInPlace(next, i, "fixed", "system", now));
    message = `${label(step)} completed.`;
    if (newlySkipped.length > 0) {
      message += ` SKIPPED: ${newlySkipped
        .map(label)
        .join(", ")}. Warn the operator now in one short sentence.`;
    } else if (earlierUnfinished.length > 0) {
      message += ` Still skipped: ${earlierUnfinished
        .map((s) => s.id)
        .join(", ")}. The operator has already been warned, do not repeat it.`;
    }
  }

  updateCompletion(procedure, next, now);
  return {
    state: next,
    result: { ok: true, message, state: summarizeState(procedure, next) },
  };
}

export function raiseIssue(
  procedure: Procedure,
  state: RunState,
  input: {
    stepId?: string | null;
    type: IssueType;
    severity: Severity;
    message: string;
    suggestedFix?: string;
    source: Source;
  },
  now: number
): { state: RunState; result: ToolResult } {
  let stepId: string | null = null;
  if (input.stepId) {
    const found = findStep(procedure, input.stepId);
    if (!found) {
      return {
        state,
        result: {
          ok: false,
          message: `Unknown step_id "${input.stepId}". Valid ids: ${procedure.steps
            .map((s) => s.id)
            .join(", ")}.`,
          state: summarizeState(procedure, state),
        },
      };
    }
    stepId = found.step.id;
  }
  const next = copy(state);
  ensureStarted(next, now);
  const { issue, isNew } = raiseInPlace(next, now, { ...input, stepId });
  return {
    state: next,
    result: {
      ok: true,
      issueId: issue.id,
      message: isNew
        ? `Issue ${issue.id} recorded and shown to the operator.`
        : `Issue ${issue.id} was already open; no need to repeat it.`,
      state: summarizeState(procedure, next),
    },
  };
}

export function resolveIssue(
  procedure: Procedure,
  state: RunState,
  input: {
    issueId: string;
    resolution: "fixed" | "dismissed";
    source: Source;
  },
  now: number
): { state: RunState; result: ToolResult } {
  const wanted = input.issueId.trim().toLowerCase();
  const target = state.issues.find((i) => i.id.toLowerCase() === wanted);
  if (!target) {
    return {
      state,
      result: {
        ok: false,
        message: `Unknown issue_id "${input.issueId}".`,
        state: summarizeState(procedure, state),
      },
    };
  }
  if (target.resolvedAt !== undefined) {
    return {
      state,
      result: {
        ok: true,
        message: `Issue ${target.id} was already resolved.`,
        state: summarizeState(procedure, state),
      },
    };
  }
  if (target.type === "skipped_step" && input.source === "ai") {
    // A skipped step is only fixed by actually doing it.
    return {
      state,
      result: {
        ok: false,
        message: `Issue ${target.id} is a skipped step. It clears by itself when you report step ${target.stepId} as completed.`,
        state: summarizeState(procedure, state),
      },
    };
  }
  const next = copy(state);
  const issue = next.issues.find((i) => i.id === target.id)!;
  resolveInPlace(next, issue, input.resolution, input.source, now);
  return {
    state: next,
    result: {
      ok: true,
      message: `Issue ${issue.id} resolved.`,
      state: summarizeState(procedure, next),
    },
  };
}

/** Stores what the AI currently sees without changing the checklist. */
export function recordObservation(state: RunState, text: string): RunState {
  if (!text || text === state.lastObservation) {
    return state;
  }
  return { ...state, lastObservation: text };
}

/** Adds a spoken line (AI or operator) to the timeline. */
export function addSpeech(
  state: RunState,
  speaker: "ai" | "operator",
  text: string,
  now: number
): RunState {
  const trimmed = text.trim();
  if (!trimmed) {
    return state;
  }
  const next = copy(state);
  addEvent(
    next,
    now,
    speaker === "ai" ? "ai_speech" : "operator_speech",
    trimmed,
    speaker
  );
  return next;
}

/**
 * Compact text version of the checklist. Sent to the AI after every tool call
 * and when a session (re)connects, so the model never relies on its memory.
 */
export function summarizeState(procedure: Procedure, state: RunState): string {
  const steps = procedure.steps
    .map((s) => `${s.id} ${state.stepStatus[s.id] ?? "pending"}`)
    .join(" | ");
  const expected = nextExpectedStep(procedure, state);
  const open = openIssues(state);
  const lines = [
    `Checklist: ${steps}`,
    expected
      ? `Next expected: ${label(expected)}`
      : "All steps are completed. The run is finished.",
  ];
  if (open.length > 0) {
    lines.push(
      `Open issues: ${open
        .map(
          (i) =>
            `${i.id} [${i.severity}] ${i.type}${
              i.stepId ? ` on ${i.stepId}` : ""
            }: ${i.message}`
        )
        .join(" ; ")}`
    );
  } else {
    lines.push("Open issues: none");
  }
  return lines.join("\n");
}
