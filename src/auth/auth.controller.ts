import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { loginInputSchema, type AuthUser, type LoginInput } from '../shared/index.js';
import { AuthService } from './auth.service.js';
import { CurrentUser, Public, type AuthedRequest } from './auth.guard.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 5 essais par minute et par adresse IP (anti force brute). */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body({ schema: loginInputSchema }) body: LoginInput, @Req() req: AuthedRequest) {
    return this.auth.login(body, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest): Promise<void> {
    if (req.token) await this.auth.logout(req.token);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
