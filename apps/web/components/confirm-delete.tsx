'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

interface ConfirmDeleteProps {
  /** The server action that deletes. */
  readonly action: (form: FormData) => Promise<void>;
  /** Hidden fields the action reads, e.g. `{ documentId: '…' }`. */
  readonly fields: Readonly<Record<string, string>>;
  /** The first button: "Delete", "Delete collection". */
  readonly label: string;
  /** What will go, in words: "Delete “Boiler manual” and its 14 passages?" */
  readonly question: string;
  /** The button that does it: "Yes, delete the manual". */
  readonly confirmLabel: string;
  /** Names the thing for a screen reader when `label` alone is ambiguous in a list. */
  readonly accessibleLabel?: string;
}

function ConfirmButton({ children }: { readonly children: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="button button-danger" type="submit" disabled={pending}>
      {pending ? 'Deleting…' : children}
    </button>
  );
}

/**
 * Deleting is never one stray click away: the first press only asks, in
 * words that say what goes, and "Keep it" (focused first, so Enter twice
 * does nothing destructive) puts everything back.
 */
export function ConfirmDelete({
  action,
  fields,
  label,
  question,
  confirmLabel,
  accessibleLabel,
}: ConfirmDeleteProps) {
  const [open, setOpen] = useState(false);
  const questionId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) keepRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (!open) {
    return (
      <button
        ref={triggerRef}
        className="button"
        type="button"
        aria-label={accessibleLabel}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <div className="confirm" role="group" aria-labelledby={questionId}>
      <p id={questionId}>
        <span aria-hidden="true">⚠ </span>
        {question} This cannot be undone.
      </p>
      <div className="actions">
        <button ref={keepRef} className="button" type="button" onClick={() => setOpen(false)}>
          Keep it
        </button>
        <form action={action}>
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <ConfirmButton>{confirmLabel}</ConfirmButton>
        </form>
      </div>
    </div>
  );
}
