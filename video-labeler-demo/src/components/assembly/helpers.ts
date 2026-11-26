import { useEffect, useRef, useState } from "react";
import { openIssues } from "../../assembly/engine";
import { useMonitorStore } from "../../assembly/store";
import { Procedure, RunState } from "../../assembly/types";

/** 83000 -> "1:23" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Re-renders once a second while `active`, and returns the current time. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

let audioCtx: AudioContext | null = null;

function beep(notes: Array<{ freq: number; at: number; length: number }>) {
  try {
    audioCtx = audioCtx ?? new AudioContext();
    const ctx = audioCtx;
    notes.forEach(({ freq, at, length }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + length + 0.05);
    });
  } catch {
    // no sound available: the visual alert is enough
  }
}

/** Plays an alarm when a new alert appears and a chime when the run is done. */
export function useAlertSound() {
  const run = useMonitorStore((s) => s.run);
  const soundOn = useMonitorStore((s) => s.soundOn);
  const seen = useRef<{ issues: Set<string>; completedAt: number | null }>({
    issues: new Set(),
    completedAt: null,
  });

  useEffect(() => {
    const alerts = openIssues(run).filter((i) => i.severity !== "info");
    const fresh = alerts.filter((i) => !seen.current.issues.has(i.id));
    const justCompleted =
      run.completedAt !== null && seen.current.completedAt === null;
    seen.current = {
      issues: new Set(run.issues.map((i) => i.id)),
      completedAt: run.completedAt,
    };
    if (!soundOn) {
      return;
    }
    if (fresh.some((i) => i.severity === "critical")) {
      beep([
        { freq: 880, at: 0, length: 0.18 },
        { freq: 660, at: 0.22, length: 0.18 },
        { freq: 880, at: 0.44, length: 0.18 },
      ]);
    } else if (fresh.length > 0) {
      beep([
        { freq: 740, at: 0, length: 0.16 },
        { freq: 740, at: 0.22, length: 0.16 },
      ]);
    } else if (justCompleted) {
      beep([
        { freq: 523, at: 0, length: 0.15 },
        { freq: 659, at: 0.15, length: 0.15 },
        { freq: 784, at: 0.3, length: 0.3 },
      ]);
    }
  }, [run, soundOn]);
}

/** Builds the downloadable record of a run: the labels this demo produces. */
export function buildRunExport(procedure: Procedure, run: RunState) {
  const start = run.startedAt;
  const rel = (t?: number) =>
    start !== null && t !== undefined
      ? Math.round((t - start) / 100) / 10
      : null;
  return {
    exportedAt: new Date().toISOString(),
    procedure: { id: procedure.id, name: procedure.name },
    startedAt: start !== null ? new Date(start).toISOString() : null,
    completedAt:
      run.completedAt !== null ? new Date(run.completedAt).toISOString() : null,
    durationSeconds: rel(run.completedAt ?? undefined),
    steps: procedure.steps.map((s) => ({
      id: s.id,
      title: s.title,
      status: run.stepStatus[s.id],
      startedAtSeconds: rel(run.stepTimes[s.id]?.startedAt),
      completedAtSeconds: rel(run.stepTimes[s.id]?.completedAt),
    })),
    issues: run.issues.map((i) => ({
      id: i.id,
      stepId: i.stepId,
      type: i.type,
      severity: i.severity,
      message: i.message,
      suggestedFix: i.suggestedFix ?? null,
      raisedBy: i.source,
      raisedAtSeconds: rel(i.raisedAt),
      resolvedAtSeconds: rel(i.resolvedAt),
      resolution: i.resolution ?? null,
    })),
    timeline: run.events.map((e) => ({
      atSeconds: rel(e.t),
      time: new Date(e.t).toISOString(),
      kind: e.kind,
      by: e.source,
      stepId: e.stepId ?? null,
      text: e.text,
    })),
  };
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
