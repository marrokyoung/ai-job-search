import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { toQueryError } from "../use-query.ts";

const focusableSelector =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled])';

export type ReasonDialogProps = {
  title: string;
  description: string;
  submitLabel: string;
  /** Resolves on success (the caller closes the dialog); rejections are shown inline. */
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
};

/**
 * A modal form that captures a required, non-blank reason before a mutating
 * action (resolving a review item, pausing or resuming automation). Focus
 * moves into the dialog on open, stays trapped inside it, and returns to the
 * previously focused element on close; Escape cancels.
 */
export function ReasonDialog({
  title,
  description,
  submitLabel,
  onSubmit,
  onCancel,
}: ReasonDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const reasonId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reasonRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!submitting) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const container = containerRef.current;
    if (!container) return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(focusableSelector),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reason.trim()) {
      setError("A reason is required.");
      reasonRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    onSubmit(reason.trim()).catch((submitError: unknown) => {
      setSubmitting(false);
      setError(toQueryError(submitError).message);
    });
  };

  return (
    <div className="dialog-overlay">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <form onSubmit={onFormSubmit}>
          <label htmlFor={reasonId}>Reason</label>
          <textarea
            id={reasonId}
            ref={reasonRef}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={5000}
            aria-required="true"
            {...(error ? { "aria-invalid": true, "aria-describedby": errorId } : {})}
          />
          {error ? (
            <p id={errorId} className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={submitting}>
              {submitting ? "Working…" : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
