import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  addSpeech,
  applyStepUpdate,
  createRun,
  resolveIssue,
  startRun,
} from "./engine";
import { BUILT_IN_PROCEDURES } from "./procedures";
import { executeTool } from "./tools";
import {
  GuidanceMode,
  Procedure,
  RunState,
  Source,
  StepUpdateStatus,
  ToolResult,
} from "./types";

/**
 * App state for the assembly monitor. The rules live in engine.ts; this store
 * only holds the current run and the user's settings, and remembers the
 * settings and custom procedures between visits.
 */

export const MIN_TICK_SECONDS = 2;
export const MAX_TICK_SECONDS = 15;

interface MonitorState {
  customProcedures: Procedure[];
  procedureId: string;
  guidanceMode: GuidanceMode;
  tickSeconds: number;
  cameraId: string | null;
  soundOn: boolean;

  run: RunState;
  /** What the AI is saying right now (live subtitle). */
  caption: string;
  /** A camera or microphone problem the user should know about. */
  notice: string | null;
  /** A recorded video that is used instead of the camera. */
  videoFile: { url: string; name: string } | null;
  videoFilePlaying: boolean;

  selectProcedure: (id: string) => void;
  saveCustomProcedure: (procedure: Procedure) => void;
  deleteCustomProcedure: (id: string) => void;
  setGuidanceMode: (mode: GuidanceMode) => void;
  setTickSeconds: (seconds: number) => void;
  setCameraId: (id: string | null) => void;
  setSoundOn: (on: boolean) => void;

  resetRun: () => void;
  beginRun: () => void;
  /** Runs a tool call from the AI (or the simulator) and returns its result. */
  dispatchTool: (name: string, args: unknown, source: Source) => ToolResult;
  setStep: (stepId: string, status: StepUpdateStatus) => void;
  dismissIssue: (issueId: string) => void;
  setCaption: (caption: string) => void;
  setNotice: (notice: string | null) => void;
  setVideoFile: (file: File | null) => void;
  /** Loads a clip that is served by the app itself. */
  setVideoUrl: (url: string, name: string) => void;
  setVideoFilePlaying: (playing: boolean) => void;
  logSpeech: (speaker: "ai" | "operator", text: string) => void;
}

export function allProcedures(custom: Procedure[]): Procedure[] {
  return [...BUILT_IN_PROCEDURES, ...custom];
}

export function findProcedure(custom: Procedure[], id: string): Procedure {
  return (
    allProcedures(custom).find((p) => p.id === id) ?? BUILT_IN_PROCEDURES[0]
  );
}

export const useMonitorStore = create<MonitorState>()(
  persist(
    (set, get) => {
      const procedure = () =>
        findProcedure(get().customProcedures, get().procedureId);

      return {
        customProcedures: [],
        procedureId: BUILT_IN_PROCEDURES[0].id,
        guidanceMode: "coach",
        tickSeconds: 3,
        cameraId: null,
        soundOn: true,

        run: createRun(BUILT_IN_PROCEDURES[0]),
        caption: "",
        notice: null,
        videoFile: null,
        videoFilePlaying: false,

        selectProcedure: (id) => {
          const next = findProcedure(get().customProcedures, id);
          set({ procedureId: next.id, run: createRun(next), caption: "" });
        },

        saveCustomProcedure: (input) => {
          const builtInIds = BUILT_IN_PROCEDURES.map((p) => p.id);
          let id = input.id;
          if (builtInIds.includes(id)) {
            id = `${id}-custom`;
          }
          const saved: Procedure = { ...input, id, custom: true };
          const others = get().customProcedures.filter((p) => p.id !== id);
          set({
            customProcedures: [...others, saved],
            procedureId: id,
            run: createRun(saved),
            caption: "",
          });
        },

        deleteCustomProcedure: (id) => {
          const customProcedures = get().customProcedures.filter(
            (p) => p.id !== id
          );
          if (get().procedureId === id) {
            const fallback = BUILT_IN_PROCEDURES[0];
            set({
              customProcedures,
              procedureId: fallback.id,
              run: createRun(fallback),
              caption: "",
            });
          } else {
            set({ customProcedures });
          }
        },

        setGuidanceMode: (guidanceMode) => set({ guidanceMode }),
        setTickSeconds: (seconds) =>
          set({
            tickSeconds: Math.min(
              MAX_TICK_SECONDS,
              Math.max(MIN_TICK_SECONDS, Math.round(seconds))
            ),
          }),
        setCameraId: (cameraId) => set({ cameraId }),
        setSoundOn: (soundOn) => set({ soundOn }),

        resetRun: () => set({ run: createRun(procedure()), caption: "" }),

        beginRun: () => set({ run: startRun(get().run, Date.now()) }),

        dispatchTool: (name, args, source) => {
          const { state, result } = executeTool(
            procedure(),
            get().run,
            name,
            args,
            source,
            Date.now()
          );
          if (state !== get().run) {
            set({ run: state });
          }
          return result;
        },

        setStep: (stepId, status) => {
          const { state } = applyStepUpdate(
            procedure(),
            get().run,
            { stepId, status, source: "operator" },
            Date.now()
          );
          set({ run: state });
        },

        dismissIssue: (issueId) => {
          const { state } = resolveIssue(
            procedure(),
            get().run,
            { issueId, resolution: "dismissed", source: "operator" },
            Date.now()
          );
          set({ run: state });
        },

        setCaption: (caption) => set({ caption }),
        setNotice: (notice) => set({ notice }),

        setVideoUrl: (url, name) => {
          const previous = get().videoFile;
          if (previous?.url.startsWith("blob:")) {
            URL.revokeObjectURL(previous.url);
          }
          set({ videoFile: { url, name }, videoFilePlaying: false, notice: null });
        },

        setVideoFile: (file) => {
          const previous = get().videoFile;
          if (previous?.url.startsWith("blob:")) {
            URL.revokeObjectURL(previous.url);
          }
          set({
            videoFile: file
              ? { url: URL.createObjectURL(file), name: file.name }
              : null,
            videoFilePlaying: false,
          });
        },
        setVideoFilePlaying: (videoFilePlaying) => set({ videoFilePlaying }),

        logSpeech: (speaker, text) =>
          set({ run: addSpeech(get().run, speaker, text, Date.now()) }),
      };
    },
    {
      name: "assembly-monitor-settings",
      storage: createJSONStorage(() => localStorage),
      // Only settings are remembered. A run always starts fresh on reload.
      partialize: (state) => ({
        customProcedures: state.customProcedures,
        procedureId: state.procedureId,
        guidanceMode: state.guidanceMode,
        tickSeconds: state.tickSeconds,
        cameraId: state.cameraId,
        soundOn: state.soundOn,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<MonitorState>;
        const merged = { ...current, ...saved };
        const procedure = findProcedure(
          merged.customProcedures ?? [],
          merged.procedureId
        );
        return {
          ...merged,
          procedureId: procedure.id,
          run: createRun(procedure),
        };
      },
    }
  )
);

/** The procedure that is currently selected. */
export function useProcedure(): Procedure {
  const custom = useMonitorStore((s) => s.customProcedures);
  const id = useMonitorStore((s) => s.procedureId);
  return findProcedure(custom, id);
}
