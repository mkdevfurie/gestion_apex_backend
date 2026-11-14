import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  changePasswordSchema,
  loginInputSchema,
  type AuthUser,
  type ChangePasswordInput,
  type LoginInput,
} from '../shared/index.js';
import { AuthService } from './auth.service.js';
import { AllowPendingPassword, CurrentUser, Public, type AuthedRequest } from './auth.guard.js';

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
  @AllowPendingPassword()
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest): Promise<void> {
    if (req.token) await this.auth.logout(req.token);
  }

  @Get('me')
  @AllowPendingPassword()
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  /** 10 essais par minute : le mot de passe actuel ne doit pas pouvoir être deviné ici. */
  @Post('password')
  @AllowPendingPassword()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  changePassword(
    @Body({ schema: changePasswordSchema }) body: ChangePasswordInput,
    @CurrentUser() user: AuthUser,
    @Req() req: AuthedRequest,
  ): Promise<AuthUser> {
    return this.auth.changePassword(user.id, req.token!, body);
  }
}
