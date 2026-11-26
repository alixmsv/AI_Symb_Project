import { nextExpectedStep } from "../../assembly/engine";
import { useMonitorStore, useProcedure } from "../../assembly/store";
import { TOOL_NAMES } from "../../assembly/tools";

/**
 * Stands in for the AI: each button sends the same tool call the model would
 * send, so the checklist, alerts and sounds can be tried without a camera or
 * an API key.
 */
export default function Simulator() {
  const procedure = useProcedure();
  const run = useMonitorStore((s) => s.run);
  const dispatchTool = useMonitorStore((s) => s.dispatchTool);

  const expected = nextExpectedStep(procedure, run);
  const expectedIndex = expected
    ? procedure.steps.findIndex((s) => s.id === expected.id)
    : -1;
  const later = procedure.steps
    .slice(expectedIndex + 1)
    .find((s) => !s.optional && run.stepStatus[s.id] !== "done");
  const lastDone = [...procedure.steps]
    .reverse()
    .find((s) => run.stepStatus[s.id] === "done");

  const send = (name: string, args: Record<string, string>) =>
    dispatchTool(name, args, "ai");

  return (
    <section className="simulator">
      <header>
        <strong>Simulator</strong>
        <span>Pretend the AI saw the operator do this:</span>
      </header>
      <div className="simulator-buttons">
        <button
          disabled={!expected}
          onClick={() =>
            expected &&
            send(TOOL_NAMES.updateStep, {
              step_id: expected.id,
              status: "completed",
              observation: `Simulated: ${expected.title} finished`,
            })
          }
        >
          Does the next step correctly
        </button>
        <button
          disabled={!later}
          onClick={() =>
            later &&
            send(TOOL_NAMES.updateStep, {
              step_id: later.id,
              status: "completed",
              observation: `Simulated: ${later.title} finished`,
            })
          }
        >
          Skips a step
        </button>
        <button
          disabled={!later}
          onClick={() =>
            later &&
            send(TOOL_NAMES.updateStep, {
              step_id: later.id,
              status: "in_progress",
              observation: `Simulated: ${later.title} started early`,
            })
          }
        >
          Starts a later step too early
        </button>
        <button
          disabled={!expected}
          onClick={() =>
            expected &&
            send(TOOL_NAMES.reportIssue, {
              step_id: expected.id,
              issue_type: "incorrect_execution",
              severity: "warning",
              message:
                expected.commonErrors?.[0] ??
                `"${expected.title}" was not done correctly.`,
              suggested_fix: expected.instruction,
            })
          }
        >
          Makes a mistake in this step
        </button>
        <button
          disabled={!lastDone}
          onClick={() =>
            lastDone &&
            send(TOOL_NAMES.updateStep, {
              step_id: lastDone.id,
              status: "not_done",
              observation: `Simulated: ${lastDone.title} taken apart`,
            })
          }
        >
          Takes the last step apart again
        </button>
      </div>
    </section>
  );
}
