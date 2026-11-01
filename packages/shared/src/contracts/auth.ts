import { z } from 'zod';

import { emailSchema, idSchema, nameSchema } from './primitives';

/**
 * Sign in with an account that exists. Accounts come from the seed today;
 * self-service sign-up is part of the library step (see docs/PLAN.md).
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

export type SignInInput = z.infer<typeof signInSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
