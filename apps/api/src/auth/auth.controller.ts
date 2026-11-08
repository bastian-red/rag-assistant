/**
 * `/auth/sign-in` and `/auth/sign-up`: the two routes on this API a person
 * reaches without a token.
 *
 * Both carry `@Budget('auth')`, which opts them into the auth budget on top of
 * the general one -- an order of magnitude below it, because this is the
 * credential-stuffing surface. `assertConsistent` refuses to boot if the two
 * numbers are the wrong way round, and `common/throttle.ts` explains why the
 * budget is opted into rather than "selected".
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { signInSchema, signUpSchema, type SessionUser } from '@rag/shared';
import type { z } from 'zod';

import { AuthService } from './auth.service';
import { CurrentUser, Public } from '../common/session.guard';
import { Budget } from '../common/throttle';
import { ZodPipe } from '../common/zod.pipe';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * 200, not 201. Signing in creates nothing; the session is the web app's and
   * lives in a cookie this process never sees.
   */
  @Public()
  @Budget('auth')
  @HttpCode(HttpStatus.OK)
  @Post('sign-in')
  signIn(
    @Body(new ZodPipe(signInSchema)) input: z.infer<typeof signInSchema>,
  ): Promise<SessionUser> {
    return this.auth.signIn(input);
  }

  /** 201 with the new account, which the web app then signs in. */
  @Public()
  @Budget('auth')
  @HttpCode(HttpStatus.CREATED)
  @Post('sign-up')
  signUp(
    @Body(new ZodPipe(signUpSchema)) input: z.infer<typeof signUpSchema>,
  ): Promise<SessionUser> {
    return this.auth.signUp(input);
  }

  /**
   * Who the token says, as the users table says it NOW. A token whose user
   * was deleted is a 401, the same as a forged one.
   */
  @Get('me')
  me(@CurrentUser() user: SessionUser): Promise<SessionUser> {
    return this.auth.current(user.id);
  }
}
