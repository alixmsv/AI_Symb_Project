/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import cn from "classnames";

import { memo, ReactNode, RefObject, useEffect, useRef, useState } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { UseMediaStreamResult } from "../../hooks/use-media-stream-mux";
import { useScreenCapture } from "../../hooks/use-screen-capture";
import { useWebcam } from "../../hooks/use-webcam";
import { AudioRecorder } from "../../lib/audio-recorder";
import AudioPulse from "../audio-pulse/AudioPulse";
import "./control-tray.scss";
import SettingsDialog from "../settings-dialog/SettingsDialog";
import { useMonitorStore } from "../../assembly/store";

export type ControlTrayProps = {
  videoRef: RefObject<HTMLVideoElement>;
  children?: ReactNode;
  supportsVideo: boolean;
  onVideoStreamChange?: (stream: MediaStream | null) => void;
  enableEditingSettings?: boolean;
};

type MediaStreamButtonProps = {
  isStreaming: boolean;
  onIcon: string;
  offIcon: string;
  start: () => Promise<any>;
  stop: () => any;
};

/**
 * button used for triggering webcam or screen-capture
 */
const MediaStreamButton = memo(
  ({ isStreaming, onIcon, offIcon, start, stop }: MediaStreamButtonProps) =>
    isStreaming ? (
      <button className="action-button" onClick={stop}>
        <span className="material-symbols-outlined">{onIcon}</span>
      </button>
    ) : (
      <button className="action-button" onClick={start}>
        <span className="material-symbols-outlined">{offIcon}</span>
      </button>
    )
);

function ControlTray({
  videoRef,
  children,
  onVideoStreamChange = () => {},
  supportsVideo,
  enableEditingSettings,
}: ControlTrayProps) {
  const videoStreams = [useWebcam(), useScreenCapture()];
  const [activeVideoStream, setActiveVideoStream] =
    useState<MediaStream | null>(null);
  const [webcam, screenCapture] = videoStreams;
  const [inVolume, setInVolume] = useState(0);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const [muted, setMuted] = useState(false);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // a recorded video can stand in for the camera
  const videoFile = useMonitorStore((s) => s.videoFile);
  const setVideoFile = useMonitorStore((s) => s.setVideoFile);

  const { client, connected, connect, disconnect, volume } =
    useLiveAPIContext();

  useEffect(() => {
    if (!connected && connectButtonRef.current) {
      connectButtonRef.current.focus();
    }
  }, [connected]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--volume",
      `${Math.max(5, Math.min(inVolume * 200, 8))}px`
    );
  }, [inVolume]);

  useEffect(() => {
    const onData = (base64: string) => {
      client.sendRealtimeInput([
        {
          mimeType: "audio/pcm;rate=16000",
          data: base64,
        },
      ]);
    };
    if (connected && !muted && audioRecorder) {
      audioRecorder
        .on("data", onData)
        .on("volume", setInVolume)
        .start()
        .catch(() => {
          // no microphone: the AI can still watch and talk, it just cannot hear
          setMuted(true);
          useMonitorStore
            .getState()
            .setNotice(
              "The microphone is blocked, so the AI cannot hear you. It still watches and speaks. Allow the microphone in the browser to talk to it."
            );
        });
    } else {
      audioRecorder.stop();
    }
    return () => {
      audioRecorder.off("data", onData).off("volume", setInVolume);
    };
  }, [connected, client, muted, audioRecorder]);

  // show either the live stream or the recorded file in the video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (videoFile) {
      // playback of a file is started by the player controls, not on load
      video.autoplay = false;
      video.srcObject = null;
      video.src = videoFile.url;
    } else {
      if (video.getAttribute("src")) {
        video.removeAttribute("src");
        video.load();
      }
      video.autoplay = true;
      video.srcObject = activeVideoStream;
    }
  }, [videoFile, activeVideoStream, videoRef]);

  // a recorded video replaces the camera or screen share
  useEffect(() => {
    if (videoFile && activeVideoStream) {
      setActiveVideoStream(null);
      onVideoStreamChange(null);
      webcam.stop();
      screenCapture.stop();
    }
    // only react to a newly loaded file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFile]);

  useEffect(() => {
    let timeoutId = -1;

    function sendVideoFrame() {
      const video = videoRef.current;
      const canvas = renderCanvasRef.current;

      if (!video || !canvas) {
        return;
      }

      // a paused or finished recording has nothing new to show
      const idle = videoFile !== null && (video.paused || video.ended);
      const ctx = canvas.getContext("2d")!;
      // small parts need detail: send frames up to 1024px wide
      const scale = Math.min(1, 1024 / (video.videoWidth || 1024));
      canvas.width = video.videoWidth * scale;
      canvas.height = video.videoHeight * scale;
      if (!idle && canvas.width + canvas.height > 0) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL("image/jpeg", 0.8);
        const data = base64.slice(base64.indexOf(",") + 1, Infinity);
        client.sendRealtimeInput([{ mimeType: "image/jpeg", data }]);
      }
      if (connected) {
        // 1 frame per second is the most the Live API accepts
        timeoutId = window.setTimeout(sendVideoFrame, 1000);
      }
    }
    if (connected && (activeVideoStream !== null || videoFile !== null)) {
      requestAnimationFrame(sendVideoFrame);
    }
    return () => {
      clearTimeout(timeoutId);
    };
  }, [connected, activeVideoStream, videoFile, client, videoRef]);

  //handler for swapping from one video-stream to the next
  const changeStreams = (next?: UseMediaStreamResult) => async () => {
    setVideoFile(null);
    if (next) {
      let mediaStream: MediaStream;
      try {
        mediaStream = await next.start();
      } catch (e) {
        useMonitorStore
          .getState()
          .setNotice(
            next.type === "webcam"
              ? "The camera could not be started. Allow camera access in the browser, check that no other app is using it, then try again."
              : "Screen sharing was cancelled or blocked."
          );
        return;
      }
      useMonitorStore.getState().setNotice(null);
      setActiveVideoStream(mediaStream);
      onVideoStreamChange(mediaStream);
    } else {
      setActiveVideoStream(null);
      onVideoStreamChange(null);
    }

    videoStreams.filter((msr) => msr !== next).forEach((msr) => msr.stop());
  };

  return (
    <section className="control-tray">
      <canvas style={{ display: "none" }} ref={renderCanvasRef} />
      <nav className={cn("actions-nav", { disabled: !connected })}>
        <button
          className={cn("action-button mic-button")}
          onClick={() => setMuted(!muted)}
        >
          {!muted ? (
            <span className="material-symbols-outlined filled">mic</span>
          ) : (
            <span className="material-symbols-outlined filled">mic_off</span>
          )}
        </button>

        <div className="action-button no-action outlined">
          <AudioPulse volume={volume} active={connected} hover={false} />
        </div>

        {supportsVideo && (
          <>
            <MediaStreamButton
              isStreaming={screenCapture.isStreaming}
              start={changeStreams(screenCapture)}
              stop={changeStreams()}
              onIcon="cancel_presentation"
              offIcon="present_to_all"
            />
            <MediaStreamButton
              isStreaming={webcam.isStreaming}
              start={changeStreams(webcam)}
              stop={changeStreams()}
              onIcon="videocam_off"
              offIcon="videocam"
            />
            <button
              className="action-button"
              // a recording can be loaded before the AI is connected
              style={{ pointerEvents: "auto" }}
              title={
                videoFile
                  ? "Close the video file"
                  : "Use a recorded video instead of the camera"
              }
              onClick={() =>
                videoFile ? setVideoFile(null) : fileInputRef.current?.click()
              }
            >
              <span className="material-symbols-outlined">
                {videoFile ? "movie_off" : "movie"}
              </span>
            </button>
            <input
              ref={fileInputRef}
              className="video-file-input"
              type="file"
              accept="video/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) {
                  return;
                }
                useMonitorStore.getState().setNotice(null);
                setVideoFile(file);
              }}
            />
          </>
        )}
        {children}
      </nav>

      <div className={cn("connection-container", { connected })}>
        <div className="connection-button-container">
          <button
            ref={connectButtonRef}
            className={cn("action-button connect-toggle", { connected })}
            onClick={connected ? disconnect : connect}
          >
            <span className="material-symbols-outlined filled">
              {connected ? "pause" : "play_arrow"}
            </span>
          </button>
        </div>
        <span className="text-indicator">Streaming</span>
      </div>
      {enableEditingSettings ? <SettingsDialog /> : ""}
    </section>
  );
}

export default memo(ControlTray);
