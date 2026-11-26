/**
 * Data model for the assembly monitor.
 *
 * A Procedure is the "work instruction" the AI is taught. A RunState is one
 * operator's attempt at that procedure, tracked step by step.
 */

export interface ProcedureStep {
  /** Short stable id the AI uses to refer to the step, e.g. "S1". */
  id: string;
  title: string;
  /** What the operator has to do. */
  instruction: string;
  /** What the camera should see once the step is finished. */
  doneWhen: string;
  /** Typical mistakes the AI should look out for. */
  commonErrors?: string[];
  /** Skipping a critical step raises a critical alert instead of a warning. */
  critical?: boolean;
  /** Optional steps never count as skipped and are not needed to finish. */
  optional?: boolean;
}

export interface Procedure {
  id: string;
  name: string;
  description: string;
  parts: string[];
  tools?: string[];
  safetyNotes?: string[];
  steps: ProcedureStep[];
  /** Recorded clips of this procedure that ship with the app, for testing. */
  sampleVideos?: { label: string; url: string }[];
  /** True for procedures the user created in the editor. */
  custom?: boolean;
}

export type StepStatus = "pending" | "in_progress" | "done" | "skipped";

export type IssueType =
  | "skipped_step"
  | "wrong_order"
  | "incorrect_execution"
  | "missing_part"
  | "safety"
  | "other";

export type Severity = "info" | "warning" | "critical";

/** Who caused a change: the AI model, the built-in rules, or the human. */
export type Source = "ai" | "system" | "operator";

export interface Issue {
  id: string;
  stepId: string | null;
  type: IssueType;
  severity: Severity;
  message: string;
  suggestedFix?: string;
  source: Source;
  raisedAt: number;
  resolvedAt?: number;
  resolution?: "fixed" | "dismissed";
}

export type RunEventKind =
  | "run_started"
  | "step_started"
  | "step_completed"
  | "step_reset"
  | "step_skipped"
  | "issue_raised"
  | "issue_resolved"
  | "run_completed"
  | "ai_speech"
  | "operator_speech"
  | "observation";

export interface RunEvent {
  id: string;
  /** Epoch milliseconds. */
  t: number;
  kind: RunEventKind;
  text: string;
  source: Source;
  stepId?: string;
  issueId?: string;
}

export interface StepTiming {
  startedAt?: number;
  completedAt?: number;
}

export interface RunState {
  procedureId: string;
  stepStatus: Record<string, StepStatus>;
  stepTimes: Record<string, StepTiming>;
  issues: Issue[];
  events: RunEvent[];
  startedAt: number | null;
  completedAt: number | null;
  /** Latest thing the AI said it saw; shown as a "what the AI sees" line. */
  lastObservation: string | null;
  /** Counter used to create ids without randomness. */
  seq: number;
}

export type RunStatus = "idle" | "running" | "attention" | "completed";

export type StepUpdateStatus = "in_progress" | "completed" | "not_done";

/** What a tool call returns to the AI. */
export interface ToolResult {
  ok: boolean;
  message: string;
  /** Compact text summary of the checklist after the call. */
  state?: string;
  issueId?: string;
}

export type GuidanceMode = "coach" | "watch";
