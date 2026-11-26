import { Procedure, ProcedureStep } from "./types";

/**
 * Built-in mock procedures.
 *
 * Both are written so they can be performed at a desk in front of a webcam
 * with everyday objects, while following the shape of a real work instruction:
 * kitting, ordered steps, a critical step that is easy to forget, and a final
 * quality check.
 */

export const PEN_ASSEMBLY: Procedure = {
  id: "pen-assembly",
  name: "Retractable pen assembly (Station 1)",
  description:
    "Mock assembly cell. The operator assembles one click pen from four loose parts on the table in front of the camera. Take a normal click pen apart beforehand to get the parts.",
  parts: [
    "Lower barrel (the half with the writing-tip opening)",
    "Upper barrel (the half with the clicker button and clip)",
    "Ink refill",
    "Spring (small metal coil)",
  ],
  tools: [],
  safetyNotes: ["Keep hands and parts inside the camera view."],
  // animated clips made by scripts/make_test_video.py
  sampleVideos: [
    {
      label: "Correct run",
      url: "/test-videos/pen-assembly-correct.webm",
    },
    {
      label: "Spring skipped",
      url: "/test-videos/pen-assembly-spring-skipped.webm",
    },
  ],
  steps: [
    {
      id: "S1",
      title: "Kitting check",
      instruction:
        "Lay out all four parts separately on the table: lower barrel, upper barrel, ink refill and spring.",
      doneWhen:
        "All four parts are visible on the table, separated from each other, and the operator's hands have moved away.",
      commonErrors: [
        "The spring is missing from the table",
        "Parts are piled up so they cannot be counted",
      ],
    },
    {
      id: "S2",
      title: "Fit spring onto refill",
      instruction:
        "Slide the spring over the writing-tip end of the ink refill.",
      doneWhen:
        "The spring is sitting on the tip end of the refill and is no longer lying loose on the table.",
      commonErrors: [
        "The spring is left on the table",
        "The spring is put on the wrong end of the refill",
      ],
      critical: true,
    },
    {
      id: "S3",
      title: "Insert refill into lower barrel",
      instruction:
        "Push the refill, spring end first, into the lower barrel until it stops.",
      doneWhen:
        "The refill is inside the lower barrel with its back end sticking out of the open side.",
      commonErrors: [
        "The refill is inserted without the spring",
        "The refill is inserted backwards",
      ],
    },
    {
      id: "S4",
      title: "Close the barrel",
      instruction:
        "Screw the upper barrel onto the lower barrel until it is hand-tight.",
      doneWhen:
        "The two barrel halves are joined into one pen body with no visible gap.",
      commonErrors: [
        "The halves are pushed together but not screwed tight",
        "The barrel is closed while the spring is still on the table",
      ],
    },
    {
      id: "S5",
      title: "Function test",
      instruction:
        "Press the clicker twice: the tip must come out and go back in.",
      doneWhen:
        "The operator has pressed the clicker at least twice on the assembled pen.",
      commonErrors: ["The pen is put away without being tested"],
      critical: true,
    },
    {
      id: "S6",
      title: "Present and place in output",
      instruction:
        "Hold the finished pen up to the camera for a moment, then place it on the right side of the table.",
      doneWhen:
        "The finished pen has been shown to the camera and is lying on its own on the right side of the table.",
    },
  ],
};

export const BOLTED_JOINT: Procedure = {
  id: "bolted-joint",
  name: "Bolted bracket joint (M8)",
  description:
    "Mock assembly cell. The operator joins two plates with one bolt, two washers and a nut, tightens it with a wrench, and marks it as tightened. Two pieces of cardboard with a hole work fine as plates.",
  parts: [
    "Bolt",
    "Two washers",
    "Nut",
    "Two plates or brackets with a hole",
  ],
  tools: ["Wrench or spanner", "Marker pen"],
  safetyNotes: [
    "Keep fingers clear of the joint while tightening with the wrench.",
  ],
  steps: [
    {
      id: "S1",
      title: "Kitting check",
      instruction:
        "Lay out the bolt, two washers, the nut, both plates, the wrench and the marker on the table.",
      doneWhen:
        "All parts and both tools are visible on the table, separated from each other.",
      commonErrors: ["Only one washer is on the table"],
    },
    {
      id: "S2",
      title: "First washer on bolt",
      instruction: "Slide one washer onto the bolt, up against the bolt head.",
      doneWhen: "One washer is sitting on the bolt under its head.",
      commonErrors: ["The bolt is used without a washer under the head"],
      critical: true,
    },
    {
      id: "S3",
      title: "Bolt through both plates",
      instruction:
        "Line up the holes of the two plates and push the bolt through both.",
      doneWhen:
        "The bolt passes through both plates and its thread sticks out on the other side.",
      commonErrors: ["The bolt only goes through one plate"],
    },
    {
      id: "S4",
      title: "Second washer on thread",
      instruction: "Slide the second washer onto the thread that sticks out.",
      doneWhen: "The second washer is on the bolt thread against the plate.",
      commonErrors: ["The nut is fitted without the second washer"],
      critical: true,
    },
    {
      id: "S5",
      title: "Fit nut hand-tight",
      instruction: "Thread the nut onto the bolt and turn it by hand until snug.",
      doneWhen: "The nut is on the bolt and seated against the washer.",
    },
    {
      id: "S6",
      title: "Tighten with wrench",
      instruction: "Tighten the nut with the wrench.",
      doneWhen:
        "The operator has used the wrench on the nut and made a tightening turn.",
      commonErrors: ["The joint is left hand-tight only"],
      critical: true,
    },
    {
      id: "S7",
      title: "Apply torque mark",
      instruction:
        "Draw a line with the marker across the nut and washer to show the joint has been tightened.",
      doneWhen: "The operator has drawn a marker line on the nut.",
      commonErrors: ["The joint is marked before it has been tightened"],
    },
  ],
};

export const BUILT_IN_PROCEDURES: Procedure[] = [PEN_ASSEMBLY, BOLTED_JOINT];

export type ProcedureValidation =
  | { ok: true; procedure: Procedure }
  | { ok: false; errors: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  return v.filter(isNonEmptyString).map((s) => s.trim());
}

/**
 * Checks a procedure that came from the JSON editor and returns a cleaned-up
 * copy, or a list of plain-language problems.
 */
export function validateProcedure(input: unknown): ProcedureValidation {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["The procedure must be a JSON object."] };
  }
  const raw = input as Record<string, unknown>;

  if (!isNonEmptyString(raw.name)) {
    errors.push('"name" is required.');
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    errors.push('"steps" must be a list with at least one step.');
  }

  const steps: ProcedureStep[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.steps)) {
    raw.steps.forEach((s, i) => {
      const label = `Step ${i + 1}`;
      if (typeof s !== "object" || s === null) {
        errors.push(`${label} must be an object.`);
        return;
      }
      const step = s as Record<string, unknown>;
      const id = isNonEmptyString(step.id) ? step.id.trim() : `S${i + 1}`;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        errors.push(
          `${label}: "id" may only contain letters, numbers, "-" and "_".`
        );
      }
      if (seen.has(id)) {
        errors.push(`${label}: the id "${id}" is used more than once.`);
      }
      seen.add(id);
      if (!isNonEmptyString(step.title)) {
        errors.push(`${label}: "title" is required.`);
      }
      if (!isNonEmptyString(step.instruction)) {
        errors.push(`${label}: "instruction" is required.`);
      }
      if (!isNonEmptyString(step.doneWhen)) {
        errors.push(
          `${label}: "doneWhen" is required (what the camera sees when the step is finished).`
        );
      }
      steps.push({
        id,
        title: String(step.title ?? "").trim(),
        instruction: String(step.instruction ?? "").trim(),
        doneWhen: String(step.doneWhen ?? "").trim(),
        commonErrors: stringList(step.commonErrors),
        critical: step.critical === true,
        optional: step.optional === true,
      });
    });
  }

  if (steps.length > 0 && steps.every((s) => s.optional)) {
    errors.push("At least one step must not be optional.");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const name = String(raw.name).trim();
  const id = isNonEmptyString(raw.id)
    ? raw.id.trim()
    : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return {
    ok: true,
    procedure: {
      id: id || "procedure",
      name,
      description: isNonEmptyString(raw.description)
        ? raw.description.trim()
        : "",
      parts: stringList(raw.parts) ?? [],
      tools: stringList(raw.tools) ?? [],
      safetyNotes: stringList(raw.safetyNotes) ?? [],
      steps,
    },
  };
}
