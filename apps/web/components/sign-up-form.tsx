'use client';

import { useActionState } from 'react';

import type { AuthFormState } from '../app/(auth)/actions';

interface SignUpFormProps {
  readonly action: (previous: AuthFormState, form: FormData) => Promise<AuthFormState>;
}

/**
 * Create an account. Like the sign-in form, a server action through
 * `useActionState`: it posts without JavaScript, and the refusal renders in
 * place as an alert. The password rule is stated before it is enforced.
 */
export function SignUpForm({ action }: SignUpFormProps) {
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <form action={formAction}>
      <label className="field">
        <span>Name</span>
        <input
          className="field-input"
          name="fullName"
          required
          maxLength={80}
          autoComplete="name"
        />
      </label>
      <label className="field">
        <span>Email</span>
        <input className="field-input" name="email" type="email" required autoComplete="email" />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          className="field-input"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          aria-describedby="password-rule"
        />
        <span id="password-rule" className="muted">
          At least 12 characters. A short sentence works well.
        </span>
      </label>
      {state.error === null ? null : (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {state.error}
        </p>
      )}
      <button className="button button-primary" type="submit" disabled={pending}>
        {pending ? 'Creating your library…' : 'Create account'}
      </button>
    </form>
  );
}
