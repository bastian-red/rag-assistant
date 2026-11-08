import { z } from 'zod';

import { emailSchema, idSchema, nameSchema, passwordSchema } from './primitives';

/**
 * Sign in with an account that exists. The password is only bounded, not held
 * to the sign-up rule, so a rule raised later cannot lock out an older account.
 */
export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

/**
 * The user shape the web app puts in its session and mints tokens from.
 *
 * There are no roles: every user owns a private library and nothing else, so
 * the only authorisation question anywhere in the API is "is this row yours?".
 * It is answered by an owner filter in the query itself, never by a role.
 *
 * Auth.js callbacks PARSE with this rather than casting. A drifted API response
 * then produces no session at all, which is a visible failure, instead of a
 * session whose `id` is `undefined` -- and in Prisma `undefined` is not "no
 * rows", it is "no filter", so that session would silently read somebody else's
 * documents.
 */
export const sessionUserSchema = z.object({
  id: idSchema,
  email: emailSchema,
  name: nameSchema,
});

/**
 * Create an account. The password rule is length only (`passwordSchema`).
 * The new account starts with one empty collection, so the library page has
 * somewhere to drop the first file.
 */
export const signUpSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  password: passwordSchema,
});

/** The collection every new account starts with. */
export const FIRST_COLLECTION_NAME = 'My documents';

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
