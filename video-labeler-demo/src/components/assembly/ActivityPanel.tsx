import cn from "classnames";
import { useState } from "react";
import { openIssues } from "../../assembly/engine";
import { useMonitorStore, useProcedure } from "../../assembly/store";
import { IssueType, RunEventKind } from "../../assembly/types";
import { formatDuration } from "./helpers";

const ISSUE_LABEL: Record<IssueType, string> = {
  skipped_step: "Skipped step",
  wrong_order: "Wrong order",
  incorrect_execution: "Done incorrectly",
  missing_part: "Missing part",
  safety: "Safety",
  other: "Note",
};

const EVENT_ICON: Record<RunEventKind, string> = {
  run_started: "play_circle",
  step_started: "pending",
  step_completed: "check_circle",
  step_reset: "undo",
  step_skipped: "error",
  issue_raised: "warning",
  issue_resolved: "task_alt",
  run_completed: "flag",
  ai_speech: "record_voice_over",
  operator_speech: "person",
  observation: "visibility",
};

const SOURCE_LABEL = { ai: "AI", system: "Rules", operator: "Operator" };

/** Alerts and the timestamped event log, in two tabs. */
export default function ActivityPanel() {
  const procedure = useProcedure();
  const run = useMonitorStore((s) => s.run);
  const dismissIssue = useMonitorStore((s) => s.dismissIssue);
  const open = openIssues(run);
  const [tab, setTab] = useState<"alerts" | "timeline">("alerts");
  const stepTitle = (id: string | null) =>
    procedure.steps.find((s) => s.id === id)?.title;
  const issues = [...run.issues].sort(
    (a, b) =>
      Number(a.resolvedAt !== undefined) - Number(b.resolvedAt !== undefined) ||
      b.raisedAt - a.raisedAt
  );
  const events = [...run.events].reverse();
  const rel = (t: number) =>
    formatDuration(run.startedAt === null ? 0 : t - run.startedAt);

  return (
    <section className="activity">
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "alerts"}
          className={cn("tab", { active: tab === "alerts" })}
          onClick={() => setTab("alerts")}
        >
          Alerts
          {open.length > 0 && <span className="count">{open.length}</span>}
        </button>
        <button
          role="tab"
          aria-selected={tab === "timeline"}
          className={cn("tab", { active: tab === "timeline" })}
          onClick={() => setTab("timeline")}
        >
          Timeline
        </button>
      </div>

      {tab === "alerts" && (
        <ul className="issue-list">
          {issues.length === 0 && (
            <li className="empty">No alerts. Mistakes the AI spots show up here.</li>
          )}
          {issues.map((issue) => {
            const resolved = issue.resolvedAt !== undefined;
            return (
              <li
                key={issue.id}
                className={cn("issue", `severity-${issue.severity}`, {
                  resolved,
                })}
              >
                <div className="issue-head">
                  <span className="issue-type">{ISSUE_LABEL[issue.type]}</span>
                  {stepTitle(issue.stepId) && (
                    <span className="issue-step">{stepTitle(issue.stepId)}</span>
                  )}
                  <span className="issue-time">{rel(issue.raisedAt)}</span>
                </div>
                <p className="issue-message">{issue.message}</p>
                {issue.suggestedFix && !resolved && (
                  <p className="issue-fix">{issue.suggestedFix}</p>
                )}
                <div className="issue-foot">
                  <span>
                    {resolved
                      ? issue.resolution === "fixed"
                        ? `Fixed at ${rel(issue.resolvedAt!)}`
                        : `Dismissed at ${rel(issue.resolvedAt!)}`
                      : `Raised by ${SOURCE_LABEL[issue.source]}`}
                  </span>
                  {!resolved && (
                    <button
                      className="text-button"
                      onClick={() => dismissIssue(issue.id)}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {tab === "timeline" && (
        <ul className="timeline">
          {events.length === 0 && (
            <li className="empty">
              Nothing yet. Every step, alert and spoken line is logged here with
              its time.
            </li>
          )}
          {events.map((event) => (
            <li key={event.id} className={cn("event", `event-${event.kind}`)}>
              <span className="event-time">{rel(event.t)}</span>
              <span className="material-symbols-outlined event-icon">
                {EVENT_ICON[event.kind]}
              </span>
              <span className="event-text">
                {event.text}
                <span className="event-source">
                  {" "}
                  · {SOURCE_LABEL[event.source]}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
