/**
 * Sign in.
 *
 * This API holds no session. It answers "are these credentials right, and who is
 * this" and nothing more; the web app puts the answer in an Auth.js session and
 * mints the short-lived service token that every other call carries. That is
 * why neither this service nor the guard touches a session table.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DomainError, type SessionUser } from '@rag/shared';
import { hashPassword, verifyPassword } from '@rag/shared/server';

import { PrismaService } from '../infra/prisma.service';

/**
 * A stored hash of a password nobody has, used only to burn the same scrypt time
 * for an unknown email as for a known one.
 *
 * Without it, sign-in for an address that exists is measurably slower than for
 * one that does not, because only the first runs scrypt. That difference is a
 * user-enumeration oracle that needs no error message to read: it is visible in
 * the response time, at scale, through any amount of noise.
 *
 * Computed once at module load rather than per request, because computing it per
 * request would double the cost of every failed sign-in.
 */
const DECOY_HASH = hashPassword('decoy-password-for-constant-time-sign-in');

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sign in, with one answer for both ways of failing.
   *
   * "No such user" and "wrong password" are the same `INVALID`, with the same
   * sentence, after the same amount of work. Distinguishing them turns the
   * sign-in form into a list of who has an account here.
   */
  async signIn(input: { email: string; password: string }): Promise<SessionUser> {
    const row = await this.prisma.client.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, passwordHash: true },
    });

    const stored = row?.passwordHash ?? DECOY_HASH;
    const correct = verifyPassword(input.password, stored);

    if (row === null || !correct) {
      throw new DomainError('INVALID', 'That email address and password do not match.');
    }
    return { id: row.id, email: row.email, name: row.name };
  }

  /** The signed-in user as stored now, or 401 if the account no longer exists. */
  async current(id: string): Promise<SessionUser> {
    const row = await this.prisma.client.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true },
    });
    if (row === null) throw new UnauthorizedException('That account no longer exists.');
    return row;
  }
}
