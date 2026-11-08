'use server';

import { sessionUserSchema, signUpSchema } from '@rag/shared';
import { AuthError } from 'next-auth';

import { signIn, signOut } from '../../auth';
import { ApiError, apiFetch } from '../../lib/api';
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

/** What a refused sign-up field says, in the reader's words. */
const SIGN_UP_FIELDS: Record<string, string> = {
  email: 'Enter an email address, like name@example.com.',
  name: 'Enter a name of 1 to 80 characters.',
  password: 'Choose a password of at least 12 characters.',
};

/**
 * Create the account, then sign in with the same credentials, which lands
 * in the new (empty) library. The API refuses a taken address with a 409
 * that says so; signing up cannot keep that secret, and the shared auth
 * budget is what bounds it (see `apps/api/src/auth/auth.service.ts`).
 */
export async function signUpAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const input = {
    email: String(form.get('email') ?? ''),
    name: String(form.get('fullName') ?? ''),
    password: String(form.get('password') ?? ''),
  };
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? 'email');
    return { error: SIGN_UP_FIELDS[field] ?? SIGN_UP_FIELDS.email! };
  }
  try {
    await apiFetch(null, '/auth/sign-up', sessionUserSchema, { method: 'POST', body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      return { error: 'Too many attempts from here. Wait a minute and try again.' };
    }
    if (error instanceof ApiError && error.status < 500) return { error: error.message };
    console.error('[web] sign-up could not be completed:', error);
    return { error: 'The account could not be created right now. Try again.' };
  }
  try {
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: '/',
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'Your account was created, but signing in failed. Sign in to continue.' };
    }
    throw error;
  }
  return { error: null };
}

/** Sign out and land on the sign-in page. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/sign-in' });
}
