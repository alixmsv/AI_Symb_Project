import {
  FunctionDeclaration,
  LiveConnectConfig,
  Modality,
  Type,
} from "@google/genai";
import { buildSystemInstruction } from "./instructions";
import { TOOL_NAMES } from "./tools";
import { GuidanceMode, Procedure } from "./types";

export const DEFAULT_MODEL = "models/gemini-3.1-flash-live-preview";

/** Override with REACT_APP_GEMINI_MODEL in .env to try another Live model. */
export const LIVE_MODEL = process.env.REACT_APP_GEMINI_MODEL || DEFAULT_MODEL;

export const DEFAULT_VOICE = "Aoede";

export function buildToolDeclarations(
  procedure: Procedure
): FunctionDeclaration[] {
  const stepIds = procedure.steps.map((s) => s.id);
  return [
    {
      name: TOOL_NAMES.updateStep,
      description:
        "Update the checklist when the operator starts a step, when you can see a step is finished, or when a finished step has been undone.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          step_id: {
            type: Type.STRING,
            enum: stepIds,
            description: "Id of the step, exactly as listed in the procedure.",
          },
          status: {
            type: Type.STRING,
            enum: ["in_progress", "completed", "not_done"],
            description:
              '"in_progress" when the operator starts the step, "completed" when its evidence is visible, "not_done" when a completed step was taken apart again.',
          },
          observation: {
            type: Type.STRING,
            description: "A few words on what you saw that justifies this update.",
          },
        },
        required: ["step_id", "status"],
      },
    },
    {
      name: TOOL_NAMES.reportIssue,
      description:
        "Report a step being done badly: wrong part, part fitted the wrong way round, part missing from the table, or something unsafe. Skipped and out-of-order steps are detected automatically from update_step, so never report those here.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          step_id: {
            type: Type.STRING,
            enum: stepIds,
            description: "Step the issue belongs to, if any.",
          },
          issue_type: {
            type: Type.STRING,
            enum: ["incorrect_execution", "missing_part", "safety", "other"],
          },
          severity: {
            type: Type.STRING,
            enum: ["info", "warning", "critical"],
            description:
              '"critical" if the product would be defective or someone could get hurt.',
          },
          message: {
            type: Type.STRING,
            description:
              "For the operator: what is wrong, in 12 words or fewer.",
          },
          suggested_fix: {
            type: Type.STRING,
            description: "How to correct it, in 12 words or fewer.",
          },
        },
        required: ["issue_type", "severity", "message"],
      },
    },
    {
      name: TOOL_NAMES.resolveIssue,
      description:
        "Close an issue you reported earlier once you can see it has been corrected.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          issue_id: {
            type: Type.STRING,
            description: 'Issue id from the checklist, for example "I7".',
          },
        },
        required: ["issue_id"],
      },
    },
    {
      name: TOOL_NAMES.logObservation,
      description:
        "Use on a tick when nothing relevant changed. Say in a few words what you currently see.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          observation: {
            type: Type.STRING,
            description: "A few words describing the scene.",
          },
        },
        required: ["observation"],
      },
    },
  ];
}

export function buildLiveConfig(
  procedure: Procedure,
  mode: GuidanceMode,
  voiceName: string = DEFAULT_VOICE
): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    },
    systemInstruction: {
      parts: [{ text: buildSystemInstruction(procedure, mode) }],
    },
    tools: [{ functionDeclarations: buildToolDeclarations(procedure) }],
    // Text versions of what the AI and the operator say, for the timeline.
    outputAudioTranscription: {},
    inputAudioTranscription: {},
    // Thinking is left at the model's default (minimal). Raising it was
    // tested and made things worse: the model stopped looking at the frames
    // and ticked off the whole procedure in one answer.
    // Without this, sessions with video end after about two minutes.
    contextWindowCompression: { slidingWindow: {} },
  };
}
