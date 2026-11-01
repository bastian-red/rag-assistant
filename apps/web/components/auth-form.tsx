'use client';

import { useActionState } from 'react';

import type { AuthFormState } from '../app/(auth)/actions';

interface AuthFormProps {
  readonly next: string;
  readonly action: (previous: AuthFormState, form: FormData) => Promise<AuthFormState>;
}

/**
 * The credentials form.
 *
 * A server action through `useActionState`, so the form works before JavaScript
 * loads (a plain POST) and the error renders in place afterwards. The error is a
 * `role="alert"` so a screen reader is told the attempt failed; without it the
 * only signal is text appearing somewhere the reader is not.
 */
export function AuthForm({ next, action }: AuthFormProps) {
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <form action={formAction}>
      <input type="hidden" name="next" value={next} />
      <label className="field">
        <span>Email</span>
        <input className="field-input" name="email" type="email" required autoComplete="username" />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          className="field-input"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
      </label>
      {state.error === null ? null : (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {state.error}
        </p>
      )}
      <button className="button button-primary" type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
