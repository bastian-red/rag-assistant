'use client';

import { LIMITS } from '@rag/shared/constants';
import { useActionState } from 'react';

import type { FormState } from '../app/library-actions';

interface Props {
  readonly action: (previous: FormState, form: FormData) => Promise<FormState>;
}

/** A new collection, opened as soon as it exists. */
export function CreateCollectionForm({ action }: Props) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="inline-form">
      <label className="field">
        <span>New collection</span>
        <input
          className="field-input"
          name="collectionName"
          required
          maxLength={LIMITS.collectionName}
          placeholder="Tax papers, Bike, Thesis…"
          autoComplete="off"
        />
      </label>
      <button className="button" type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create'}
      </button>
      {state.error === null ? null : (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {state.error}
        </p>
      )}
    </form>
  );
}
