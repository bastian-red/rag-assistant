/**
 * A reader's address, as this system keeps it: never in the clear.
 *
 * HMAC-SHA256 under the deployment's secret, so the same address always maps
 * to the same hash (a flood from one place is still one place, for the rate
 * limit and the moderation queue), but a hash cannot be turned back into an
 * address by hashing the 4 billion IPv4 addresses, which a plain SHA-256 can
 * in minutes. The purpose string keeps this hash from equalling any other HMAC
 * made with the same secret.
 */
import { createHmac } from 'node:crypto';

export function addressHash(secret: string, address: string): string {
  return createHmac('sha256', secret).update(`reader-address\u0000${address}`).digest('hex');
}
