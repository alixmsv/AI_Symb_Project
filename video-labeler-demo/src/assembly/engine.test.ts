import {
  addSpeech,
  applyStepUpdate,
  createRun,
  nextExpectedStep,
  openIssues,
  progress,
  raiseIssue,
  resolveIssue,
  runStatus,
  startRun,
  summarizeState,
  topIssue,
} from "./engine";
import { PEN_ASSEMBLY } from "./procedures";
import { Procedure, RunState, StepUpdateStatus } from "./types";

const procedure = PEN_ASSEMBLY;

function step(
  state: RunState,
  stepId: string,
  status: StepUpdateStatus,
  now = 1000,
  p: Procedure = procedure
) {
  return applyStepUpdate(p, state, { stepId, status, source: "ai" }, now);
}

function completeInOrder(ids: string[], start = createRun(procedure)) {
  return ids.reduce(
    (state, id, i) => step(state, id, "completed", 1000 * (i + 1)).state,
    start
  );
}

describe("a run done correctly", () => {
  it("starts idle with every step pending", () => {
    const run = createRun(procedure);
    expect(runStatus(run)).toBe("idle");
    expect(progress(procedure, run)).toEqual({ done: 0, total: 6 });
    expect(nextExpectedStep(procedure, run)?.id).toBe("S1");
  });

  it("tracks progress and finishes without alerts", () => {
    const run = completeInOrder(["S1", "S2", "S3", "S4", "S5", "S6"]);
    expect(progress(procedure, run)).toEqual({ done: 6, total: 6 });
    expect(openIssues(run)).toHaveLength(0);
    expect(run.completedAt).toBe(6000);
    expect(runStatus(run)).toBe("completed");
    expect(nextExpectedStep(procedure, run)).toBeNull();
    expect(run.events.map((e) => e.kind)).toContain("run_completed");
  });

  it("starts the clock on the first reported activity", () => {
    const { state } = step(createRun(procedure), "S1", "in_progress", 500);
    expect(state.startedAt).toBe(500);
    expect(state.stepStatus.S1).toBe("in_progress");
    expect(runStatus(state)).toBe("running");
  });

  it("records how long a step took", () => {
    let run = step(createRun(procedure), "S1", "in_progress", 1000).state;
    run = step(run, "S1", "completed", 4000).state;
    expect(run.stepTimes.S1).toEqual({ startedAt: 1000, completedAt: 4000 });
  });

  it("does not change the original state object", () => {
    const run = createRun(procedure);
    step(run, "S1", "completed");
    expect(run.stepStatus.S1).toBe("pending");
    expect(run.events).toHaveLength(0);
  });
});

describe("skipped steps", () => {
  it("flags a critical step that was jumped over", () => {
    const run = completeInOrder(["S1", "S3"]);
    expect(run.stepStatus.S2).toBe("skipped");
    expect(run.stepStatus.S3).toBe("done");
    const issue = topIssue(run)!;
    expect(issue.type).toBe("skipped_step");
    expect(issue.stepId).toBe("S2");
    expect(issue.severity).toBe("critical");
    expect(issue.source).toBe("system");
    expect(runStatus(run)).toBe("attention");
  });

  it("uses a warning for a skipped step that is not critical", () => {
    const run = completeInOrder(["S2"]);
    const issue = openIssues(run).find((i) => i.stepId === "S1")!;
    expect(issue.severity).toBe("warning");
  });

  it("tells the AI about the skip in the tool result", () => {
    const run = completeInOrder(["S1"]);
    const { result } = step(run, "S3", "completed");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("SKIPPED");
    expect(result.message).toContain("S2");
    expect(result.state).toContain("S2 skipped");
  });

  it("warns about a skip once and does not repeat it on later steps", () => {
    const run = completeInOrder(["S1", "S3"]);
    const { result, state } = step(run, "S4", "completed", 5000);
    expect(result.message).not.toContain("SKIPPED");
    expect(result.message).toContain("Still skipped: S2");
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0].message).toContain("Insert refill into lower barrel");
  });

  it("does not bring back a skip alert the operator dismissed", () => {
    let run = completeInOrder(["S1", "S3"]);
    run = resolveIssue(
      procedure,
      run,
      { issueId: topIssue(run)!.id, resolution: "dismissed", source: "operator" },
      4000
    ).state;
    run = step(run, "S4", "completed", 5000).state;
    expect(openIssues(run)).toHaveLength(0);
    expect(run.stepStatus.S2).toBe("skipped");
  });

  it("keeps pointing at the skipped step until it is done", () => {
    const run = completeInOrder(["S1", "S3", "S4"]);
    expect(nextExpectedStep(procedure, run)?.id).toBe("S2");
    // jumping over S2 again must not create a second alert for it
    expect(openIssues(run).filter((i) => i.stepId === "S2")).toHaveLength(1);
  });

  it("clears the alert once the operator goes back and does the step", () => {
    let run = completeInOrder(["S1", "S3"]);
    run = step(run, "S2", "completed", 9000).state;
    expect(run.stepStatus.S2).toBe("done");
    expect(openIssues(run)).toHaveLength(0);
    expect(run.issues[0].resolution).toBe("fixed");
    expect(runStatus(run)).toBe("running");
  });

  it("does not finish the run while a step is skipped", () => {
    const run = completeInOrder(["S1", "S3", "S4", "S5", "S6"]);
    expect(run.completedAt).toBeNull();
    expect(progress(procedure, run)).toEqual({ done: 5, total: 6 });
  });

  it("does not let the AI close a skipped-step alert without the step", () => {
    const run = completeInOrder(["S1", "S3"]);
    const issue = topIssue(run)!;
    const { state, result } = resolveIssue(
      procedure,
      run,
      { issueId: issue.id, resolution: "fixed", source: "ai" },
      5000
    );
    expect(result.ok).toBe(false);
    expect(openIssues(state)).toHaveLength(1);
  });

  it("lets the operator dismiss any alert", () => {
    const run = completeInOrder(["S1", "S3"]);
    const issue = topIssue(run)!;
    const { state } = resolveIssue(
      procedure,
      run,
      { issueId: issue.id, resolution: "dismissed", source: "operator" },
      5000
    );
    expect(openIssues(state)).toHaveLength(0);
    expect(state.issues[0].resolution).toBe("dismissed");
  });

  it("never counts an optional step as skipped", () => {
    const withOptional: Procedure = {
      ...procedure,
      steps: procedure.steps.map((s) =>
        s.id === "S2" ? { ...s, optional: true } : s
      ),
    };
    let run = createRun(withOptional);
    run = step(run, "S1", "completed", 1000, withOptional).state;
    run = step(run, "S3", "completed", 2000, withOptional).state;
    expect(run.stepStatus.S2).toBe("pending");
    expect(openIssues(run)).toHaveLength(0);
    expect(progress(withOptional, run).total).toBe(5);
  });
});

describe("wrong order", () => {
  it("warns when a later step is started early", () => {
    const run = completeInOrder(["S1"]);
    const { state, result } = step(run, "S4", "in_progress", 3000);
    const issue = topIssue(state)!;
    expect(issue.type).toBe("wrong_order");
    expect(issue.severity).toBe("warning");
    expect(issue.stepId).toBe("S4");
    expect(result.message).toContain("Out of order");
    // nothing is marked skipped until the later step is actually finished
    expect(state.stepStatus.S2).toBe("pending");
  });

  it("does not repeat the warning on every look", () => {
    let run = completeInOrder(["S1"]);
    run = step(run, "S4", "in_progress", 3000).state;
    run = step(run, "S4", "in_progress", 6000).state;
    expect(run.issues).toHaveLength(1);
  });

  it("drops the warning when the operator returns to the right step", () => {
    let run = completeInOrder(["S1"]);
    run = step(run, "S4", "in_progress", 3000).state;
    run = step(run, "S2", "in_progress", 4000).state;
    expect(run.stepStatus.S4).toBe("pending");
    expect(run.stepStatus.S2).toBe("in_progress");
    run = completeInOrder(["S2", "S3", "S4"], run);
    expect(openIssues(run)).toHaveLength(0);
  });

  it("keeps only one step in progress", () => {
    let run = step(createRun(procedure), "S1", "in_progress").state;
    run = step(run, "S2", "in_progress").state;
    const active = Object.values(run.stepStatus).filter(
      (s) => s === "in_progress"
    );
    expect(active).toHaveLength(1);
  });
});

describe("rework", () => {
  it("reopens a finished step and un-finishes the run", () => {
    let run = completeInOrder(["S1", "S2", "S3", "S4", "S5", "S6"]);
    run = step(run, "S4", "not_done", 9000).state;
    expect(run.stepStatus.S4).toBe("pending");
    expect(run.completedAt).toBeNull();
    expect(nextExpectedStep(procedure, run)?.id).toBe("S4");
    run = step(run, "S4", "completed", 9500).state;
    expect(run.completedAt).toBe(9500);
  });

  it("ignores a repeated report of a finished step", () => {
    const run = completeInOrder(["S1"]);
    const again = step(run, "S1", "completed", 5000);
    expect(again.state.stepTimes.S1.completedAt).toBe(1000);
    expect(again.result.message).toContain("already completed");
    const restart = step(run, "S1", "in_progress", 5000);
    expect(restart.state.stepStatus.S1).toBe("done");
  });
});

describe("issues reported by the AI", () => {
  const report = (state: RunState, message: string, now = 2000) =>
    raiseIssue(
      procedure,
      state,
      {
        stepId: "S2",
        type: "incorrect_execution",
        severity: "warning",
        message,
        source: "ai",
      },
      now
    );

  it("records the issue and returns its id", () => {
    const { state, result } = report(createRun(procedure), "Spring on wrong end");
    expect(result.ok).toBe(true);
    expect(result.issueId).toBe(state.issues[0].id);
    expect(runStatus(state)).toBe("attention");
  });

  it("merges a repeat of the same problem into the open issue", () => {
    let { state } = report(createRun(procedure), "Spring on wrong end");
    const second = report(state, "Spring is still on the wrong end", 4000);
    state = second.state;
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0].message).toBe("Spring is still on the wrong end");
    expect(second.result.message).toContain("already open");
  });

  it("closes the issue when the step is then completed", () => {
    let { state } = report(createRun(procedure), "Spring on wrong end");
    state = completeInOrder(["S1", "S2"], state);
    expect(openIssues(state)).toHaveLength(0);
  });

  it("lets the AI resolve an issue it reported", () => {
    const { state, result } = report(createRun(procedure), "Spring on wrong end");
    const resolved = resolveIssue(
      procedure,
      state,
      { issueId: result.issueId!, resolution: "fixed", source: "ai" },
      3000
    );
    expect(resolved.result.ok).toBe(true);
    expect(openIssues(resolved.state)).toHaveLength(0);
  });

  it("ranks a critical issue above a newer warning", () => {
    let run = completeInOrder(["S1", "S3"]); // critical skip of S2
    run = raiseIssue(
      procedure,
      run,
      {
        stepId: "S4",
        type: "other",
        severity: "warning",
        message: "Table is cluttered",
        source: "ai",
      },
      9000
    ).state;
    expect(topIssue(run)!.severity).toBe("critical");
  });

  it("rejects an unknown step or issue id without changing anything", () => {
    const run = createRun(procedure);
    const badStep = step(run, "S99", "completed");
    expect(badStep.result.ok).toBe(false);
    expect(badStep.result.message).toContain("S1, S2");
    expect(badStep.state).toBe(run);
    const badIssue = resolveIssue(
      procedure,
      run,
      { issueId: "I42", resolution: "fixed", source: "ai" },
      1
    );
    expect(badIssue.result.ok).toBe(false);
  });

  it("accepts step ids in any letter case", () => {
    const { state } = step(createRun(procedure), "s1", "completed");
    expect(state.stepStatus.S1).toBe("done");
  });
});

describe("summary for the AI", () => {
  it("lists every step, the next one and open issues", () => {
    const run = completeInOrder(["S1", "S3"]);
    const text = summarizeState(procedure, run);
    expect(text).toContain("S1 done | S2 skipped | S3 done | S4 pending");
    expect(text).toContain('Next expected: S2 "Fit spring onto refill"');
    expect(text).toMatch(/Open issues: I\d+ \[critical\] skipped_step on S2/);
  });

  it("says when the run is finished", () => {
    const run = completeInOrder(["S1", "S2", "S3", "S4", "S5", "S6"]);
    expect(summarizeState(procedure, run)).toContain("The run is finished");
  });
});

describe("timeline", () => {
  it("logs speech and ignores empty lines", () => {
    let run = startRun(createRun(procedure), 100);
    run = addSpeech(run, "ai", "  Good. Now insert the refill. ", 200);
    const same = addSpeech(run, "operator", "   ", 300);
    expect(same).toBe(run);
    const last = run.events[run.events.length - 1];
    expect(last.kind).toBe("ai_speech");
    expect(last.text).toBe("Good. Now insert the refill.");
  });

  it("gives every event and issue a unique id", () => {
    const run = completeInOrder(["S1", "S4", "S2", "S3"]);
    const ids = [...run.events.map((e) => e.id), ...run.issues.map((i) => i.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
