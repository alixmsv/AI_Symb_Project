import cn from "classnames";
import { RefObject, useEffect, useRef, useState } from "react";
import {
  nextExpectedStep,
  progress,
  topIssue,
} from "../../assembly/engine";
import { useMonitorStore, useProcedure } from "../../assembly/store";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { formatDuration } from "./helpers";

type Props = {
  videoRef: RefObject<HTMLVideoElement>;
  /** there is a picture to show (camera, screen or a loaded video file) */
  videoActive: boolean;
  /** the picture is moving, so the AI has something to watch */
  videoLive: boolean;
};

/**
 * Play, pause, restart and seek for a recorded video. The recording plays
 * while the AI session is connected, so the AI does not miss the beginning.
 */
function FilePlayer({ videoRef }: { videoRef: RefObject<HTMLVideoElement> }) {
  const { connected } = useLiveAPIContext();
  const videoFile = useMonitorStore((s) => s.videoFile);
  const setPlaying = useMonitorStore((s) => s.setVideoFilePlaying);
  const resetRun = useMonitorStore((s) => s.resetRun);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setLocalPlaying] = useState(false);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoFile) {
      return;
    }
    const sync = () => {
      const isPlaying = !video.paused && !video.ended;
      setTime(video.currentTime);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setLocalPlaying(isPlaying);
      setPlaying(isPlaying);
    };
    const start = () => {
      if (connectedRef.current) {
        video.play().catch(() => {});
      }
    };
    const events = [
      "play",
      "pause",
      "ended",
      "timeupdate",
      "durationchange",
      "seeked",
      "emptied",
    ];
    events.forEach((e) => video.addEventListener(e, sync));
    video.addEventListener("loadeddata", start);
    sync();
    return () => {
      events.forEach((e) => video.removeEventListener(e, sync));
      video.removeEventListener("loadeddata", start);
      setPlaying(false);
    };
  }, [videoFile, videoRef, setPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoFile) {
      return;
    }
    if (!connected) {
      video.pause();
    } else if (!video.ended && video.readyState >= 2) {
      video.play().catch(() => {});
    }
  }, [connected, videoFile, videoRef]);

  if (!videoFile) {
    return null;
  }
  const video = videoRef.current;
  const ended = duration > 0 && time >= duration - 0.05;

  return (
    <div className="file-player">
      <button
        className="icon-button material-symbols-outlined filled"
        title={playing ? "Pause" : "Play"}
        onClick={() => {
          if (!video) {
            return;
          }
          if (playing) {
            video.pause();
          } else {
            if (ended) {
              video.currentTime = 0;
            }
            video.play().catch(() => {});
          }
        }}
      >
        {playing ? "pause" : "play_arrow"}
      </button>
      <button
        className="icon-button material-symbols-outlined"
        title="Start the video and the checklist again from the beginning"
        onClick={() => {
          if (!video) {
            return;
          }
          resetRun();
          video.currentTime = 0;
          if (connected) {
            video.play().catch(() => {});
          }
        }}
      >
        replay
      </button>
      <input
        type="range"
        aria-label="Position in the video"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(time, duration || 0)}
        onChange={(e) => {
          if (video) {
            video.currentTime = Number(e.target.value);
          }
        }}
      />
      <span className="file-time">
        {formatDuration(time * 1000)} / {formatDuration(duration * 1000)}
      </span>
      <span className="file-name" title={videoFile.name}>
        {videoFile.name}
      </span>
      {!connected && (
        <span className="file-hint">Press play below to let the AI watch</span>
      )}
    </div>
  );
}

/**
 * The camera view with everything the operator needs on top of it: the alert
 * banner, the current instruction, and subtitles of what the AI says.
 */
export default function VideoStage({
  videoRef,
  videoActive,
  videoLive,
}: Props) {
  const { connected, lastError } = useLiveAPIContext();
  const procedure = useProcedure();
  const run = useMonitorStore((s) => s.run);
  const caption = useMonitorStore((s) => s.caption);
  const notice = useMonitorStore((s) => s.notice);
  const setNotice = useMonitorStore((s) => s.setNotice);
  const dismissIssue = useMonitorStore((s) => s.dismissIssue);
  const resetRun = useMonitorStore((s) => s.resetRun);

  const issue = topIssue(run);
  const alert = issue && issue.severity !== "info" ? issue : null;
  const expected = nextExpectedStep(procedure, run);
  const expectedIndex = expected
    ? procedure.steps.findIndex((s) => s.id === expected.id)
    : -1;
  const { done, total } = progress(procedure, run);
  const completed = run.completedAt !== null;
  const watching = connected && videoLive;
  const fileLoaded = useMonitorStore((s) => s.videoFile !== null);
  const setVideoUrl = useMonitorStore((s) => s.setVideoUrl);

  return (
    <section
      className={cn("stage", {
        "stage-alert": alert !== null,
        "stage-critical": alert?.severity === "critical",
        "stage-complete": completed && !alert,
      })}
    >
      <div className="banners">
        {lastError && !connected && (
          <div className="banner banner-error" role="alert">
            <span className="material-symbols-outlined filled">cloud_off</span>
            <div className="banner-text">
              <strong>{lastError}</strong>
              <span>
                Your progress is kept. Press play to reconnect and the AI
                carries on from the current step.
              </span>
            </div>
          </div>
        )}

        {notice && (
          <div className="banner banner-error" role="status">
            <span className="material-symbols-outlined filled">info</span>
            <div className="banner-text">
              <span>{notice}</span>
            </div>
            <button className="text-button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        {alert && (
          <div
            className={cn("banner", `banner-${alert.severity}`)}
            role="alert"
            aria-live="assertive"
          >
            <span className="material-symbols-outlined filled">
              {alert.severity === "critical" ? "error" : "warning"}
            </span>
            <div className="banner-text">
              <strong>{alert.message}</strong>
              {alert.suggestedFix && <span>{alert.suggestedFix}</span>}
            </div>
            <button
              className="text-button"
              onClick={() => dismissIssue(alert.id)}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div className="stage-view">
        <video
          className={cn("stage-video", { hidden: !videoActive })}
          ref={videoRef}
          autoPlay
          playsInline
          muted
        />

        {!videoActive && (
          <div className="stage-placeholder">
            <h2>{procedure.name}</h2>
            {procedure.description && <p>{procedure.description}</p>}
            <div className="placeholder-columns">
              <div>
                <h3>You need</h3>
                <ul>
                  {[...procedure.parts, ...(procedure.tools ?? [])].map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>To start</h3>
                <ol>
                  <li>
                    Press{" "}
                    <span className="material-symbols-outlined filled inline-icon">
                      play_arrow
                    </span>{" "}
                    below to connect the AI.
                  </li>
                  <li>
                    Press{" "}
                    <span className="material-symbols-outlined inline-icon">
                      videocam
                    </span>{" "}
                  to turn the camera on and point it at your table, or{" "}
                    <span className="material-symbols-outlined inline-icon">
                      movie
                    </span>{" "}
                    to load a recorded video.
                  </li>
                  <li>Do the steps. The AI ticks them off and warns you.</li>
                </ol>
                {procedure.sampleVideos && procedure.sampleVideos.length > 0 && (
                  <div className="samples">
                    <span>No parts at hand? Use a sample video:</span>
                    {procedure.sampleVideos.map((sample) => (
                      <button
                        key={sample.url}
                        className="pill-button ghost"
                        onClick={() =>
                          setVideoUrl(sample.url, `Sample: ${sample.label}`)
                        }
                      >
                        <span className="material-symbols-outlined">movie</span>
                        {sample.label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="hint">
                  No camera or API key? Open the simulator at the top right to try
                  the checklist and alerts without the AI.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="stage-top">
          <span className={cn("chip", { live: watching })}>
            <span className="dot" />
            {watching
              ? "AI is watching"
              : !connected
              ? "AI not connected"
              : fileLoaded
              ? "Connected · video paused"
              : "Connected · camera off"}
          </span>
          {watching && run.lastObservation && (
            <span className="chip observation" title="What the AI last reported seeing">
              <span className="material-symbols-outlined">visibility</span>
              {run.lastObservation}
            </span>
          )}
        </div>


          {caption && (
            <div className="caption" aria-live="polite">
              <span className="material-symbols-outlined">record_voice_over</span>
              {caption}
            </div>
          )}
      </div>

      <div className="stage-bottom">
        <FilePlayer videoRef={videoRef} />
        {completed ? (
          <div className="instruction instruction-complete">
            <span className="material-symbols-outlined filled big">
              check_circle
            </span>
            <div className="instruction-text">
              <span className="instruction-label">Assembly complete</span>
              <span className="instruction-title">
                {done} of {total} steps in{" "}
                {formatDuration(run.completedAt! - (run.startedAt ?? 0))}
              </span>
            </div>
            <button className="pill-button" onClick={resetRun}>
              Start next unit
            </button>
          </div>
        ) : (
          expected && (
            <div className="instruction">
              <span className="instruction-count">
                {expectedIndex + 1}
                <small>/{procedure.steps.length}</small>
              </span>
              <div className="instruction-text">
                <span className="instruction-label">
                  {run.stepStatus[expected.id] === "skipped"
                    ? "Skipped — go back and do this"
                    : "Next step"}
                  : {expected.title}
                </span>
                <span className="instruction-title">{expected.instruction}</span>
              </div>
            </div>
          )
        )}
      </div>
    </section>
  );
}
