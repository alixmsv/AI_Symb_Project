import { useEffect, useRef } from "react";
import { LiveServerToolCall } from "@google/genai";
import { useLiveAPIContext } from "../contexts/LiveAPIContext";
import { buildSyncMessage, buildTickMessage } from "./instructions";
import { buildLiveConfig, LIVE_MODEL } from "./liveConfig";
import { useMonitorStore, useProcedure } from "./store";
import { blockedWithoutVideo, TurnGuard } from "./tools";

/** If the model never finishes a turn, stop waiting for it after this long. */
const TURN_TIMEOUT_MS = 20000;
/** Do not interrupt the operator: wait this long after they last spoke. */
const OPERATOR_QUIET_MS = 1500;
/** How long a finished subtitle stays on screen. */
const CAPTION_HOLD_MS = 5000;

/**
 * Connects the Gemini Live session to the assembly checklist.
 *
 * - teaches the model the selected procedure (system instruction + tools)
 * - applies the model's tool calls to the run and answers them
 * - asks the model to look at the video every few seconds ("ticks"), because
 *   the model does not react to video on its own
 * - collects what the AI and the operator say for subtitles and the timeline
 */
export function useAssemblyMonitor(videoActive: boolean) {
  const { client, connected, setConfig, setModel } = useLiveAPIContext();
  const procedure = useProcedure();
  const guidanceMode = useMonitorStore((s) => s.guidanceMode);
  const tickSeconds = useMonitorStore((s) => s.tickSeconds);

  const videoActiveRef = useRef(videoActive);
  videoActiveRef.current = videoActive;

  const guard = useRef(new TurnGuard());

  const turn = useRef({
    ready: false,
    awaiting: false,
    awaitingSince: 0,
    lastTurnEnd: 0,
    lastOperatorSpeech: 0,
  });

  // Teach the model the procedure. Applied the next time a session starts.
  useEffect(() => {
    setModel(LIVE_MODEL);
    setConfig(buildLiveConfig(procedure, guidanceMode));
  }, [procedure, guidanceMode, setConfig, setModel]);

  // Session lifecycle, tool calls and speech.
  useEffect(() => {
    const store = useMonitorStore;
    let aiSpeech = "";
    let operatorSpeech = "";
    let captionTimer = -1;

    const flushSpeech = () => {
      if (operatorSpeech.trim()) {
        store.getState().logSpeech("operator", operatorSpeech);
      }
      operatorSpeech = "";
      if (aiSpeech.trim()) {
        store.getState().logSpeech("ai", aiSpeech);
        window.clearTimeout(captionTimer);
        captionTimer = window.setTimeout(
          () => store.getState().setCaption(""),
          CAPTION_HOLD_MS
        );
      }
      aiSpeech = "";
    };

    const onSetupComplete = () => {
      const state = store.getState();
      state.beginRun();
      // Give the model the current checklist. On a reconnect this is what lets
      // it carry on where the previous session stopped.
      client.sendRealtimeText(
        buildSyncMessage(procedure, store.getState().run)
      );
      guard.current.begin("sync");
      turn.current = {
        ready: true,
        awaiting: true,
        awaitingSince: Date.now(),
        lastTurnEnd: 0,
        lastOperatorSpeech: 0,
      };
    };

    const onToolCall = (toolCall: LiveServerToolCall) => {
      const calls = toolCall.functionCalls ?? [];
      if (calls.length === 0) {
        return;
      }
      client.sendToolResponse({
        functionResponses: calls.map((fc) => ({
          id: fc.id,
          name: fc.name,
          response: {
            // without a picture the model can only be guessing
            result:
              (!videoActiveRef.current && blockedWithoutVideo(fc.name ?? "")) ||
              // and it may not run ahead of the video
              guard.current.check(fc.name ?? "", fc.args) ||
              store.getState().dispatchTool(fc.name ?? "", fc.args, "ai"),
          },
        })),
      });
      // The model continues its turn after a tool response.
      turn.current.awaiting = true;
      turn.current.awaitingSince = Date.now();
    };

    const onTurnEnd = () => {
      flushSpeech();
      // whatever comes next (a tick or the operator speaking) is a new look
      guard.current.begin("look");
      turn.current.awaiting = false;
      turn.current.lastTurnEnd = Date.now();
    };

    const onOutputTranscription = (text: string) => {
      if (!aiSpeech) {
        window.clearTimeout(captionTimer);
      }
      aiSpeech += text;
      store.getState().setCaption(aiSpeech.trim());
    };

    const onInputTranscription = (text: string) => {
      operatorSpeech += text;
      turn.current.lastOperatorSpeech = Date.now();
    };

    const onClose = () => {
      flushSpeech();
      turn.current.ready = false;
      turn.current.awaiting = false;
    };

    client
      .on("setupcomplete", onSetupComplete)
      .on("toolcall", onToolCall)
      .on("turncomplete", onTurnEnd)
      .on("interrupted", onTurnEnd)
      .on("outputtranscription", onOutputTranscription)
      .on("inputtranscription", onInputTranscription)
      .on("close", onClose);

    return () => {
      window.clearTimeout(captionTimer);
      client
        .off("setupcomplete", onSetupComplete)
        .off("toolcall", onToolCall)
        .off("turncomplete", onTurnEnd)
        .off("interrupted", onTurnEnd)
        .off("outputtranscription", onOutputTranscription)
        .off("inputtranscription", onInputTranscription)
        .off("close", onClose);
    };
  }, [client, procedure]);

  // Ticks: ask the model to look at the video, one question at a time.
  useEffect(() => {
    if (!connected || !videoActive) {
      return;
    }
    const interval = window.setInterval(() => {
      const now = Date.now();
      const t = turn.current;
      const run = useMonitorStore.getState().run;
      if (!t.ready || run.completedAt !== null) {
        return;
      }
      if (t.awaiting && now - t.awaitingSince < TURN_TIMEOUT_MS) {
        return;
      }
      if (now - t.lastTurnEnd < tickSeconds * 1000) {
        return;
      }
      if (now - t.lastOperatorSpeech < OPERATOR_QUIET_MS) {
        return;
      }
      if (client.sendRealtimeText(buildTickMessage(procedure, run, now))) {
        guard.current.begin("look");
        t.awaiting = true;
        t.awaitingSince = now;
      }
    }, 250);
    return () => window.clearInterval(interval);
  }, [client, connected, videoActive, procedure, tickSeconds]);
}
