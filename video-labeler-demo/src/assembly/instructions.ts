import { nextExpectedStep, summarizeState } from "./engine";
import { TOOL_NAMES } from "./tools";
import { GuidanceMode, Procedure, RunState } from "./types";

/**
 * All text that is sent to the AI model lives here: the system instruction
 * that teaches it the procedure, and the short messages the app sends during
 * a session. Kept free of SDK imports so it can be unit tested.
 */

/** Prefix of the periodic "look now" message sent by the app. */
export const TICK_PREFIX = "[TICK]";
/** Prefix of the checklist snapshot sent when a session (re)connects. */
export const SYNC_PREFIX = "[STATE]";

function procedureBlock(procedure: Procedure): string {
  const lines: string[] = [`# Procedure: ${procedure.name}`];
  if (procedure.description) {
    lines.push(procedure.description);
  }
  if (procedure.parts.length) {
    lines.push("", "Parts:", ...procedure.parts.map((p) => `- ${p}`));
  }
  if (procedure.tools?.length) {
    lines.push("", "Tools:", ...procedure.tools.map((t) => `- ${t}`));
  }
  if (procedure.safetyNotes?.length) {
    lines.push("", "Safety:", ...procedure.safetyNotes.map((s) => `- ${s}`));
  }
  lines.push("", "Steps, in the order they must be done:");
  procedure.steps.forEach((step, i) => {
    const flags = [
      step.critical ? "CRITICAL" : "",
      step.optional ? "optional" : "",
    ].filter(Boolean);
    lines.push(
      "",
      `${i + 1}. id ${step.id}: ${step.title}${
        flags.length ? ` (${flags.join(", ")})` : ""
      }`,
      `   Do: ${step.instruction}`,
      `   Completed when you can see: ${step.doneWhen}`
    );
    if (step.commonErrors?.length) {
      lines.push(`   Typical mistakes: ${step.commonErrors.join("; ")}`);
    }
  });
  return lines.join("\n");
}

function speakingRules(mode: GuidanceMode): string {
  const common = [
    "- Speak English. Say at most ONE short sentence per answer, 12 words or fewer. While you talk you cannot watch, so long speech makes you miss steps.",
    "- When a tool result says a step was SKIPPED or is out of order, or when you report an issue, tell the operator right away in one short sentence what to fix, for example: \"Stop, the spring is missing. Take the refill out again.\" Say it once, do not repeat it on later ticks.",
    "- If the operator asks you something, answer briefly.",
    `- Never read ${TICK_PREFIX} or ${SYNC_PREFIX} messages aloud, and never mention ticks, tools, step ids or this software.`,
    "- When the run is finished, say once that the assembly is complete, then stay silent.",
  ];
  if (mode === "coach") {
    return [
      "- When a step is completed, confirm it and say what to do next, for example: \"Good. Now screw the two halves together.\"",
      "- At the start of the session, greet the operator in one sentence and name the first open step.",
      "- If nothing changed, say nothing at all.",
      ...common,
    ].join("\n");
  }
  return [
    "- Stay silent while the work goes well. Do not confirm steps and do not announce the next step.",
    "- If nothing changed, say nothing at all.",
    ...common,
  ].join("\n");
}

export function buildSystemInstruction(
  procedure: Procedure,
  mode: GuidanceMode
): string {
  return `You are the AI co-worker at a manual assembly workstation. A camera shows you the operator's table. Your job is to keep the digital checklist in sync with what the operator really does, and to warn the operator when a step is skipped, done in the wrong order, or done incorrectly.

${procedureBlock(procedure)}

# What you receive
- Camera frames, about one per second.
- The operator's voice.
- Text messages from the workstation software, not from the operator: "${TICK_PREFIX}" means "look at the latest frames now", and "${SYNC_PREFIX}" gives you the current checklist.

# How to work
On every ${TICK_PREFIX}, compare the latest frames with the step that is expected next, then answer with tool calls. Tools are the only way to change the checklist.
- ${TOOL_NAMES.updateStep}: the operator has started a step (status "in_progress"), you can see a step is finished (status "completed"), or a finished step has been taken apart again (status "not_done").
- ${TOOL_NAMES.reportIssue}: you see a step being done badly: a wrong part, a part put on the wrong way round, a part missing from the table, or something unsafe. Not for skipped or out-of-order steps.
- ${TOOL_NAMES.resolveIssue}: you can see the operator has corrected an issue you reported.
- ${TOOL_NAMES.logObservation}: nothing relevant changed since the last tick. Give a few words about what you see.

Rules:
- A step takes the operator several seconds, and there are pauses between steps. On most ticks nothing is finished yet, and the right answer is ${TOOL_NAMES.logObservation}. Right after one step is completed, the next one has usually not even started.
- Only report a step as completed when you can actually see its "completed when" evidence in the camera frames. Never guess, and never complete a step because it is the expected one or because time has passed.
- Your observation must describe what is really in the latest frames. If you have not received any camera frame, or the picture is black or frozen, you cannot see the table: use ${TOOL_NAMES.logObservation} with "no camera image" and do not update any step.
- Report every step the operator physically does with ${TOOL_NAMES.updateStep}, also when it is done too early or while an earlier step is still open. Example: the refill is pushed into the barrel although the spring is still on the table: report the insert step as completed. The workstation software then detects the skipped step itself, raises the alert and tells you in the tool result. Do not use ${TOOL_NAMES.reportIssue} for this, and never hold back a step because an earlier one is missing.
- If your view is blocked or the image is unclear, use ${TOOL_NAMES.logObservation} and say so. If it stays unclear, ask the operator to hold the part up to the camera.
- Every tool result contains the current checklist. Trust it over your own memory.
- Several steps can be reported in one answer if you saw them all happen.

# Speaking
${speakingRules(mode)}`;
}

/** Sent once when a session opens or reconnects. */
export function buildSyncMessage(
  procedure: Procedure,
  state: RunState
): string {
  return `${SYNC_PREFIX} Session started. Current checklist:\n${summarizeState(
    procedure,
    state
  )}`;
}

/** Sent every few seconds while the camera is on. */
export function buildTickMessage(
  procedure: Procedure,
  state: RunState,
  now: number
): string {
  const expected = nextExpectedStep(procedure, state);
  const elapsed =
    state.startedAt === null ? 0 : Math.round((now - state.startedAt) / 1000);
  if (!expected) {
    return `${TICK_PREFIX} t=${elapsed}s. All steps are completed. Call ${TOOL_NAMES.logObservation} unless a finished step was undone.`;
  }
  const open = procedure.steps
    .filter((s) => state.stepStatus[s.id] !== "done")
    .map((s) => `${s.id} "${s.title}"`)
    .join(", ");
  // Naming only "the next step" made the model tick it off too eagerly, so the
  // message lists everything that is open and asks for what is visible.
  return `${TICK_PREFIX} t=${elapsed}s. Still open: ${open}. What do the latest frames show right now? Report a step only if you can see it happening or finished in these frames; otherwise log what you see.`;
}
