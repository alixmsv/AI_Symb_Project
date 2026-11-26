import {
  applyStepUpdate,
  raiseIssue,
  recordObservation,
  resolveIssue,
  summarizeState,
} from "./engine";
import {
  IssueType,
  Procedure,
  RunState,
  Severity,
  Source,
  StepUpdateStatus,
  ToolResult,
} from "./types";

/**
 * Turns a tool call from the AI (name + loosely typed arguments) into a change
 * of the run. Models do not always stick to the exact enum spelling, so the
 * arguments are normalised here instead of being trusted.
 */

export const TOOL_NAMES = {
  updateStep: "update_step",
  reportIssue: "report_issue",
  resolveIssue: "resolve_issue",
  logObservation: "log_observation",
} as const;

const ISSUE_TYPES: IssueType[] = [
  "skipped_step",
  "wrong_order",
  "incorrect_execution",
  "missing_part",
  "safety",
  "other",
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normaliseKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[\s-]+/g, "_");
}

export function parseStepStatus(value: unknown): StepUpdateStatus | null {
  switch (normaliseKey(value)) {
    case "in_progress":
    case "started":
    case "start":
    case "active":
      return "in_progress";
    case "completed":
    case "complete":
    case "done":
    case "finished":
      return "completed";
    case "not_done":
    case "undone":
    case "pending":
    case "reset":
      return "not_done";
    default:
      return null;
  }
}

export function parseSeverity(value: unknown): Severity {
  switch (normaliseKey(value)) {
    case "critical":
    case "high":
      return "critical";
    case "info":
    case "low":
      return "info";
    default:
      return "warning";
  }
}

export function parseIssueType(value: unknown): IssueType {
  const key = normaliseKey(value) as IssueType;
  return ISSUE_TYPES.includes(key) ? key : "other";
}

/**
 * The model sometimes reports progress it cannot have seen. Step updates are
 * therefore refused while no picture is being sent to it.
 */
export function blockedWithoutVideo(name: string): ToolResult | null {
  if (name !== TOOL_NAMES.updateStep && name !== TOOL_NAMES.reportIssue) {
    return null;
  }
  return {
    ok: false,
    message:
      "No camera image is being sent right now, so nothing can be confirmed. Do not update the checklist until the camera is on.",
  };
}

/** How many steps the model may tick off in one answer. */
export const MAX_COMPLETIONS_PER_TURN = 2;

/**
 * Keeps the model from running ahead of the video. It may not change steps
 * before it has been asked to look for the first time, and it may not tick
 * off more than a couple of steps in a single answer.
 */
export class TurnGuard {
  private kind: "sync" | "look" = "sync";
  private completions = 0;

  /** Call when a new model turn starts. */
  begin(kind: "sync" | "look") {
    this.kind = kind;
    this.completions = 0;
  }

  /** Returns a refusal for the model, or null if the call may go ahead. */
  check(name: string, rawArgs: unknown): ToolResult | null {
    if (name !== TOOL_NAMES.updateStep) {
      return null;
    }
    if (this.kind === "sync") {
      return {
        ok: false,
        message:
          "Not applied. Wait until you are asked to look at the frames before you update steps.",
      };
    }
    const status = parseStepStatus(
      (rawArgs as Record<string, unknown> | null)?.status
    );
    if (status === "completed") {
      this.completions += 1;
      if (this.completions > MAX_COMPLETIONS_PER_TURN) {
        return {
          ok: false,
          message:
            "Not applied. That is too many steps at once. Stop, and report only what the frames show when you are asked to look again.",
        };
      }
    }
    return null;
  }
}

export function executeTool(
  procedure: Procedure,
  state: RunState,
  name: string,
  rawArgs: unknown,
  source: Source,
  now: number
): { state: RunState; result: ToolResult } {
  const args =
    typeof rawArgs === "object" && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {};
  const fail = (message: string) => ({
    state,
    result: { ok: false, message, state: summarizeState(procedure, state) },
  });

  switch (name) {
    case TOOL_NAMES.updateStep: {
      const stepId = text(args.step_id);
      const status = parseStepStatus(args.status);
      if (!stepId) {
        return fail("step_id is required.");
      }
      if (!status) {
        return fail(
          'status must be "in_progress", "completed" or "not_done".'
        );
      }
      return applyStepUpdate(
        procedure,
        state,
        {
          stepId,
          status,
          observation: text(args.observation) || undefined,
          source,
        },
        now
      );
    }

    case TOOL_NAMES.reportIssue: {
      const message = text(args.message);
      if (!message) {
        return fail("message is required.");
      }
      return raiseIssue(
        procedure,
        state,
        {
          stepId: text(args.step_id) || null,
          type: parseIssueType(args.issue_type),
          severity: parseSeverity(args.severity),
          message,
          suggestedFix: text(args.suggested_fix) || undefined,
          source,
        },
        now
      );
    }

    case TOOL_NAMES.resolveIssue: {
      const issueId = text(args.issue_id);
      if (!issueId) {
        return fail("issue_id is required.");
      }
      return resolveIssue(
        procedure,
        state,
        { issueId, resolution: "fixed", source },
        now
      );
    }

    case TOOL_NAMES.logObservation: {
      const next = recordObservation(state, text(args.observation));
      return {
        state: next,
        result: {
          ok: true,
          message: "Noted. Stay silent.",
          state: summarizeState(procedure, next),
        },
      };
    }

    default:
      return fail(
        `Unknown tool "${name}". Available tools: ${Object.values(
          TOOL_NAMES
        ).join(", ")}.`
      );
  }
}
