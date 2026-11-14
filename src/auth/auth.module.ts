import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Module({
  // Limites appliquées uniquement là où ThrottlerGuard est posé (login).
  // 600 requêtes / minute / IP : large pour la caisse, bloque le moissonnage et le déni de service applicatif.
  imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }])],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
