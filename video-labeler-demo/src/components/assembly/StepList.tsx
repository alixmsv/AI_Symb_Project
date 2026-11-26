import cn from "classnames";
import { nextExpectedStep } from "../../assembly/engine";
import { useMonitorStore, useProcedure } from "../../assembly/store";
import { StepStatus } from "../../assembly/types";
import { formatDuration } from "./helpers";

const STATUS_ICON: Record<StepStatus, string> = {
  pending: "radio_button_unchecked",
  in_progress: "pending",
  done: "check_circle",
  skipped: "error",
};

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "To do",
  in_progress: "In progress",
  done: "Done",
  skipped: "Skipped",
};

/** The checklist: every step with its live status and manual overrides. */
export default function StepList() {
  const procedure = useProcedure();
  const run = useMonitorStore((s) => s.run);
  const setStep = useMonitorStore((s) => s.setStep);
  const expected = nextExpectedStep(procedure, run);

  return (
    <ol className="step-list">
      {procedure.steps.map((step, i) => {
        const status = run.stepStatus[step.id] ?? "pending";
        const times = run.stepTimes[step.id];
        const isExpected = expected?.id === step.id;
        const duration =
          times?.startedAt !== undefined && times.completedAt !== undefined
            ? formatDuration(times.completedAt - times.startedAt)
            : null;
        return (
          <li
            key={step.id}
            className={cn("step", `step-${status}`, { expected: isExpected })}
          >
            <span
              className={cn("material-symbols-outlined step-icon", {
                filled: status === "done" || status === "skipped",
              })}
              title={STATUS_LABEL[status]}
            >
              {STATUS_ICON[status]}
            </span>
            <div className="step-body">
              <div className="step-title">
                <span className="step-number">{i + 1}.</span> {step.title}
                {step.critical && <span className="tag critical">critical</span>}
                {step.optional && <span className="tag">optional</span>}
              </div>
              <div className="step-meta">
                {STATUS_LABEL[status]}
                {duration && status === "done" ? ` · ${duration}` : ""}
              </div>
              {(isExpected || status === "skipped") && (
                <p className="step-instruction">{step.instruction}</p>
              )}
            </div>
            <div className="step-actions">
              {status === "done" ? (
                <button
                  className="icon-button material-symbols-outlined"
                  title="Reopen this step"
                  onClick={() => setStep(step.id, "not_done")}
                >
                  undo
                </button>
              ) : (
                <button
                  className="icon-button material-symbols-outlined"
                  title="Mark as done by hand"
                  onClick={() => setStep(step.id, "completed")}
                >
                  check
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
