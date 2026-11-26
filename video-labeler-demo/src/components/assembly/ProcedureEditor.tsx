import { useState } from "react";
import { validateProcedure } from "../../assembly/procedures";
import { useMonitorStore, useProcedure } from "../../assembly/store";

type Props = { onClose: () => void };

/**
 * Lets the user teach the AI their own task: the procedure is edited as JSON
 * and saved as a personal copy, so the built-in examples stay untouched.
 */
export default function ProcedureEditor({ onClose }: Props) {
  const procedure = useProcedure();
  const saveCustomProcedure = useMonitorStore((s) => s.saveCustomProcedure);
  const deleteCustomProcedure = useMonitorStore((s) => s.deleteCustomProcedure);
  const [text, setText] = useState(() => {
    const { custom, ...editable } = procedure;
    return JSON.stringify(editable, null, 2);
  });
  const [errors, setErrors] = useState<string[]>([]);

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErrors([`This is not valid JSON: ${(e as Error).message}`]);
      return;
    }
    const result = validateProcedure(parsed);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    saveCustomProcedure(result.procedure);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit procedure"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>Edit procedure</h2>
          <button
            className="icon-button material-symbols-outlined"
            onClick={onClose}
            title="Close"
          >
            close
          </button>
        </header>
        <p className="modal-help">
          This is what the AI is taught. Each step needs an <code>id</code>, a{" "}
          <code>title</code>, an <code>instruction</code> for the operator and a{" "}
          <code>doneWhen</code> that says what the camera sees once the step is
          finished. Add <code>"critical": true</code> to steps that must never be
          skipped.{" "}
          {procedure.custom
            ? "Saving updates your procedure and restarts the run."
            : "Saving creates your own copy and restarts the run."}
        </p>
        <textarea
          className="modal-editor"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setErrors([]);
          }}
        />
        {errors.length > 0 && (
          <ul className="modal-errors" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <footer>
          {procedure.custom && (
            <button
              className="pill-button danger"
              onClick={() => {
                deleteCustomProcedure(procedure.id);
                onClose();
              }}
            >
              Delete this procedure
            </button>
          )}
          <span className="spacer" />
          <button className="pill-button ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="pill-button" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
