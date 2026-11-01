import { z } from 'zod';

/**
 * The small shapes every other contract is built from.
 *
 * Everything here is a zod schema with its TypeScript type derived by `z.infer`.
 * Never a hand-written interface beside a schema: the two drift, and the one
 * that drifts is always the one that is not validated.
 */

/** A cuid, which is what every `@id @default(cuid())` in the schema produces. */
export const idSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const nameSchema = z.string().trim().min(1).max(80);

/**
 * At least 12 characters. Not a composition rule -- no "one digit, one symbol" --
 * because those push people towards `Password1!` and measurably lower entropy.
 * Length is the property that matters.
 */
export const passwordSchema = z.string().min(12).max(200);

/** An ISO 8601 instant. Always UTC on the wire; rendering picks a zone. */
export const instantSchema = z.string().datetime();

export type Id = z.infer<typeof idSchema>;
