import { createRun, openIssues } from "./engine";
import {
  buildSyncMessage,
  buildSystemInstruction,
  buildTickMessage,
  SYNC_PREFIX,
  TICK_PREFIX,
} from "./instructions";
import {
  BOLTED_JOINT,
  BUILT_IN_PROCEDURES,
  PEN_ASSEMBLY,
  validateProcedure,
} from "./procedures";
import {
  blockedWithoutVideo,
  executeTool,
  parseIssueType,
  parseSeverity,
  parseStepStatus,
  TOOL_NAMES,
  TurnGuard,
} from "./tools";

const procedure = PEN_ASSEMBLY;
const call = (name: string, args: unknown, state = createRun(procedure)) =>
  executeTool(procedure, state, name, args, "ai", 1000);

describe("tool calls from the AI", () => {
  it("update_step completes a step", () => {
    const { state, result } = call(TOOL_NAMES.updateStep, {
      step_id: "S1",
      status: "completed",
      observation: "four parts on the table",
    });
    expect(result.ok).toBe(true);
    expect(state.stepStatus.S1).toBe("done");
    expect(state.lastObservation).toBe("four parts on the table");
  });

  it("accepts loose spellings of the status", () => {
    expect(parseStepStatus("Completed")).toBe("completed");
    expect(parseStepStatus("done")).toBe("completed");
    expect(parseStepStatus("in progress")).toBe("in_progress");
    expect(parseStepStatus("IN-PROGRESS")).toBe("in_progress");
    expect(parseStepStatus("not done")).toBe("not_done");
    expect(parseStepStatus("maybe")).toBeNull();
    expect(parseStepStatus(undefined)).toBeNull();
  });

  it("falls back to safe values for unknown severity and type", () => {
    expect(parseSeverity("CRITICAL")).toBe("critical");
    expect(parseSeverity("whatever")).toBe("warning");
    expect(parseSeverity(undefined)).toBe("warning");
    expect(parseIssueType("Missing Part")).toBe("missing_part");
    expect(parseIssueType("nonsense")).toBe("other");
  });

  it("report_issue raises an alert", () => {
    const { state, result } = call(TOOL_NAMES.reportIssue, {
      step_id: "S2",
      issue_type: "incorrect_execution",
      severity: "critical",
      message: "Spring is on the wrong end",
      suggested_fix: "Move it to the tip end",
    });
    expect(result.ok).toBe(true);
    const [issue] = openIssues(state);
    expect(issue.severity).toBe("critical");
    expect(issue.suggestedFix).toBe("Move it to the tip end");
    expect(issue.source).toBe("ai");
  });

  it("report_issue works without a step", () => {
    const { state } = call(TOOL_NAMES.reportIssue, {
      issue_type: "safety",
      severity: "warning",
      message: "Hands are outside the camera view",
    });
    expect(openIssues(state)[0].stepId).toBeNull();
  });

  it("resolve_issue closes an AI-reported issue", () => {
    const first = call(TOOL_NAMES.reportIssue, {
      step_id: "S2",
      issue_type: "incorrect_execution",
      severity: "warning",
      message: "Spring is on the wrong end",
    });
    const second = call(
      TOOL_NAMES.resolveIssue,
      { issue_id: first.result.issueId },
      first.state
    );
    expect(second.result.ok).toBe(true);
    expect(openIssues(second.state)).toHaveLength(0);
  });

  it("log_observation changes nothing but the observation", () => {
    const run = createRun(procedure);
    const { state, result } = call(
      TOOL_NAMES.logObservation,
      { observation: "hands resting" },
      run
    );
    expect(result.ok).toBe(true);
    expect(state.lastObservation).toBe("hands resting");
    expect(state.events).toHaveLength(0);
    expect(state.startedAt).toBeNull();
  });

  it("answers bad calls with an error instead of throwing", () => {
    expect(call("make_coffee", {}).result.ok).toBe(false);
    expect(call(TOOL_NAMES.updateStep, {}).result.ok).toBe(false);
    expect(call(TOOL_NAMES.updateStep, { step_id: "S1" }).result.ok).toBe(false);
    expect(call(TOOL_NAMES.updateStep, null).result.ok).toBe(false);
    expect(call(TOOL_NAMES.reportIssue, { severity: "critical" }).result.ok).toBe(
      false
    );
    expect(call(TOOL_NAMES.resolveIssue, {}).result.ok).toBe(false);
  });

  it("refuses checklist changes while no picture is sent", () => {
    expect(blockedWithoutVideo(TOOL_NAMES.updateStep)?.ok).toBe(false);
    expect(blockedWithoutVideo(TOOL_NAMES.reportIssue)?.ok).toBe(false);
    expect(blockedWithoutVideo(TOOL_NAMES.logObservation)).toBeNull();
    expect(blockedWithoutVideo(TOOL_NAMES.resolveIssue)).toBeNull();
  });

  it("does not let the model run ahead of the video", () => {
    const guard = new TurnGuard();
    const done = (id: string) => ({ step_id: id, status: "completed" });
    // nothing may be ticked off before the first look
    guard.begin("sync");
    expect(guard.check(TOOL_NAMES.updateStep, done("S1"))?.ok).toBe(false);
    expect(guard.check(TOOL_NAMES.logObservation, {})).toBeNull();
    // two steps per look are fine, a third is refused
    guard.begin("look");
    expect(guard.check(TOOL_NAMES.updateStep, done("S1"))).toBeNull();
    expect(
      guard.check(TOOL_NAMES.updateStep, { step_id: "S2", status: "in_progress" })
    ).toBeNull();
    expect(guard.check(TOOL_NAMES.updateStep, done("S2"))).toBeNull();
    expect(guard.check(TOOL_NAMES.updateStep, done("S3"))?.ok).toBe(false);
    expect(guard.check(TOOL_NAMES.reportIssue, {})).toBeNull();
    // the next look starts fresh
    guard.begin("look");
    expect(guard.check(TOOL_NAMES.updateStep, done("S3"))).toBeNull();
  });

  it("always returns the checklist so the AI stays in sync", () => {
    expect(call(TOOL_NAMES.updateStep, {}).result.state).toContain("Checklist:");
    expect(
      call(TOOL_NAMES.logObservation, { observation: "x" }).result.state
    ).toContain("Next expected: S1");
  });
});

describe("text sent to the AI", () => {
  it("teaches every step with its evidence and mistakes", () => {
    const text = buildSystemInstruction(procedure, "coach");
    procedure.steps.forEach((s) => {
      expect(text).toContain(`id ${s.id}: ${s.title}`);
      expect(text).toContain(s.doneWhen);
    });
    expect(text).toContain("CRITICAL");
    expect(text).toContain("Typical mistakes: The spring is left on the table");
    Object.values(TOOL_NAMES).forEach((name) => expect(text).toContain(name));
  });

  it("changes the speaking rules with the guidance mode", () => {
    const coach = buildSystemInstruction(procedure, "coach");
    const watch = buildSystemInstruction(procedure, "watch");
    expect(coach).toContain("say what to do next");
    expect(watch).toContain("Stay silent while the work goes well");
    expect(watch).not.toContain("say what to do next");
  });

  it("builds tick and sync messages from the run", () => {
    const run = call(TOOL_NAMES.updateStep, {
      step_id: "S1",
      status: "completed",
    }).state;
    const tick = buildTickMessage(procedure, run, 13000);
    expect(tick.startsWith(TICK_PREFIX)).toBe(true);
    expect(tick).toContain("t=12s");
    expect(tick).toContain('Still open: S2 "Fit spring onto refill", S3');
    expect(tick).not.toContain("S1");
    const sync = buildSyncMessage(procedure, run);
    expect(sync.startsWith(SYNC_PREFIX)).toBe(true);
    expect(sync).toContain("S1 done | S2 pending");
  });
});

describe("procedures", () => {
  it("ships valid built-in procedures with unique ids", () => {
    BUILT_IN_PROCEDURES.forEach((p) => {
      const result = validateProcedure(JSON.parse(JSON.stringify(p)));
      expect(result.ok).toBe(true);
      expect(new Set(p.steps.map((s) => s.id)).size).toBe(p.steps.length);
    });
    expect(BOLTED_JOINT.steps.some((s) => s.critical)).toBe(true);
  });

  it("fills in missing ids and cleans the input", () => {
    const result = validateProcedure({
      name: "  My task ",
      steps: [
        { title: "A", instruction: "do a", doneWhen: "a is visible" },
        { title: "B", instruction: "do b", doneWhen: "b is visible", critical: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.procedure.id).toBe("my-task");
      expect(result.procedure.name).toBe("My task");
      expect(result.procedure.steps.map((s) => s.id)).toEqual(["S1", "S2"]);
      expect(result.procedure.steps[1].critical).toBe(true);
      expect(result.procedure.parts).toEqual([]);
    }
  });

  it("explains what is wrong with a bad procedure", () => {
    const result = validateProcedure({
      steps: [
        { id: "A", title: "A", instruction: "x", doneWhen: "y" },
        { id: "A", title: "", instruction: "x" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const all = result.errors.join("\n");
      expect(all).toContain('"name" is required');
      expect(all).toContain("used more than once");
      expect(all).toContain('Step 2: "title" is required');
      expect(all).toContain('Step 2: "doneWhen" is required');
    }
    expect(validateProcedure([]).ok).toBe(false);
    expect(validateProcedure({ name: "x", steps: [] }).ok).toBe(false);
  });
});
