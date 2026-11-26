import cn from "classnames";
import { RefObject, useEffect, useState } from "react";
import { progress, runStatus } from "../../assembly/engine";
import {
  allProcedures,
  MAX_TICK_SECONDS,
  MIN_TICK_SECONDS,
  useMonitorStore,
  useProcedure,
} from "../../assembly/store";
import { GuidanceMode, RunStatus } from "../../assembly/types";
import { useAssemblyMonitor } from "../../assembly/useAssemblyMonitor";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import ActivityPanel from "./ActivityPanel";
import {
  buildRunExport,
  downloadJson,
  formatDuration,
  useAlertSound,
  useNow,
} from "./helpers";
import ProcedureEditor from "./ProcedureEditor";
import Simulator from "./Simulator";
import StepList from "./StepList";
import VideoStage from "./VideoStage";
import "./assembly.scss";

const STATUS_TEXT: Record<RunStatus, string> = {
  idle: "Ready",
  running: "Running",
  attention: "Needs attention",
  completed: "Complete",
};

function useCameras(videoActive: boolean) {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) {
      return;
    }
    let cancelled = false;
    const refresh = () =>
      devices
        .enumerateDevices()
        .then((list) => {
          if (!cancelled) {
            setCameras(list.filter((d) => d.kind === "videoinput"));
          }
        })
        .catch(() => {});
    refresh();
    devices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      devices.removeEventListener?.("devicechange", refresh);
    };
    // camera names only become readable once the camera has been allowed
  }, [videoActive]);
  return cameras;
}

type Props = {
  videoRef: RefObject<HTMLVideoElement>;
  videoActive: boolean;
};

/** The whole operator screen: header, camera view, checklist and activity. */
export default function AssemblyMonitor({ videoRef, videoActive }: Props) {
  const store = useMonitorStore();
  // a recorded video counts as "something to watch" only while it plays
  const hasVideo = videoActive || store.videoFile !== null;
  const videoLive =
    videoActive || (store.videoFile !== null && store.videoFilePlaying);
  useAssemblyMonitor(videoLive);
  useAlertSound();

  const { connected } = useLiveAPIContext();
  const procedure = useProcedure();
  const { run } = store;
  const status = runStatus(run);
  const { done, total } = progress(procedure, run);
  const running = run.startedAt !== null && run.completedAt === null;
  const now = useNow(running);
  const elapsed =
    run.startedAt === null ? 0 : (run.completedAt ?? now) - run.startedAt;
  const cameras = useCameras(videoActive);
  const [editing, setEditing] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const lockedHint = connected
    ? "Stop the session (pause button) to change this"
    : undefined;

  return (
    <div className="assembly">
      <header className="assembly-header">
        <div className="header-row">
          <label className="field procedure-field" title={lockedHint}>
            <span>Procedure</span>
            <select
              value={procedure.id}
              disabled={connected}
              onChange={(e) => store.selectProcedure(e.target.value)}
            >
              {allProcedures(store.customProcedures).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.custom ? " (mine)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="pill-button ghost"
            disabled={connected}
            title={lockedHint}
            onClick={() => setEditing(true)}
          >
            <span className="material-symbols-outlined">edit</span>Edit
          </button>

          <span className="spacer" />

          <span className={cn("status-pill", `status-${status}`)}>
            {STATUS_TEXT[status]}
          </span>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-label="Steps completed"
          >
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${total ? (done / total) * 100 : 0}%` }}
              />
            </div>
            <span>
              {done}/{total} steps
            </span>
          </div>
          <span className="timer" title="Time since the run started">
            <span className="material-symbols-outlined">timer</span>
            {formatDuration(elapsed)}
          </span>
        </div>

        <div className="header-row toolbar">
          <label className="field" title={lockedHint}>
            <span>AI voice</span>
            <select
              value={store.guidanceMode}
              disabled={connected}
              onChange={(e) =>
                store.setGuidanceMode(e.target.value as GuidanceMode)
              }
            >
              <option value="coach">Coach: talks me through each step</option>
              <option value="watch">Watch: only speaks when something is wrong</option>
            </select>
          </label>
          <label
            className="field"
            title="Takes effect the next time you turn the camera on"
          >
            <span>Camera</span>
            <select
              value={store.cameraId ?? ""}
              onChange={(e) => store.setCameraId(e.target.value || null)}
            >
              <option value="">Default camera</option>
              {cameras
                .filter((c) => c.deviceId)
                .map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `Camera ${i + 1}`}
                  </option>
                ))}
            </select>
          </label>
          <label
            className="field narrow"
            title="How often the AI is asked to look at the video"
          >
            <span>Check every</span>
            <span className="number-with-unit">
              <input
                type="number"
                min={MIN_TICK_SECONDS}
                max={MAX_TICK_SECONDS}
                value={store.tickSeconds}
                onChange={(e) => store.setTickSeconds(Number(e.target.value))}
              />
              s
            </span>
          </label>

          <span className="spacer" />

          <button
            className="pill-button ghost"
            aria-pressed={store.soundOn}
            onClick={() => store.setSoundOn(!store.soundOn)}
            title={store.soundOn ? "Alert sounds are on" : "Alert sounds are off"}
          >
            <span className="material-symbols-outlined">
              {store.soundOn ? "volume_up" : "volume_off"}
            </span>
            Sound
          </button>
          <button
            className="pill-button ghost"
            disabled={run.events.length === 0}
            onClick={() =>
              downloadJson(
                `run-${procedure.id}-${new Date()
                  .toISOString()
                  .slice(0, 19)
                  .replace(/[:T]/g, "-")}.json`,
                buildRunExport(procedure, run)
              )
            }
            title="Download the steps, alerts and timeline of this run"
          >
            <span className="material-symbols-outlined">download</span>Export run
          </button>
          <button
            className="pill-button ghost"
            disabled={run.startedAt === null}
            onClick={store.resetRun}
            title="Clear the checklist and start again"
          >
            <span className="material-symbols-outlined">restart_alt</span>Reset
          </button>
          <button
            className={cn("pill-button ghost", { active: simulating })}
            aria-pressed={simulating}
            onClick={() => setSimulating(!simulating)}
            title="Try the checklist and alerts without the AI"
          >
            <span className="material-symbols-outlined">science</span>Simulator
          </button>
        </div>
      </header>

      <div className="assembly-body">
        <VideoStage
          videoRef={videoRef}
          videoActive={hasVideo}
          videoLive={videoLive}
        />
        <aside className="assembly-side">
          {simulating && <Simulator />}
          <h3 className="side-title">Checklist</h3>
          <StepList />
          <ActivityPanel />
        </aside>
      </div>

      {editing && <ProcedureEditor onClose={() => setEditing(false)} />}
    </div>
  );
}
