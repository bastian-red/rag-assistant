'use server';

import { AuthError } from 'next-auth';

import { signIn, signOut } from '../../auth';
import { safeNextPath } from '../../lib/next-path';

export interface AuthFormState {
  readonly error: string | null;
}

/**
 * Sign in, then go back where the reader came from.
 *
 * `signIn` redirects by THROWING Next's redirect signal, so the catch must let
 * anything that is not an `AuthError` through; swallowing it would turn every
 * successful sign-in into a form that just sits there.
 *
 * The message does not say which half was wrong. The API spends the same scrypt
 * time on an unknown address as on a wrong password so the answer cannot be read
 * off the clock; a friendlier sentence here would undo that at the last step.
 */
export async function signInAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  try {
    await signIn('credentials', {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      redirectTo: safeNextPath(String(form.get('next') ?? '')),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'That email address and password do not match.' };
    }
    throw error;
  }
  return { error: null };
}

/** Sign out and land on the sign-in page. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/sign-in' });
}
