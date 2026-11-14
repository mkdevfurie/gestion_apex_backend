import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { permissions, type AuthUser, type Permission } from '../shared/index.js';
import { AuthService } from './auth.service.js';

const PUBLIC = 'auth:public';
const PERMISSION = 'auth:permission';
const PENDING_PASSWORD_OK = 'auth:pending-password-ok';

/** Route accessible sans connexion (santé, login). Tout le reste est protégé. */
export const Public = () => SetMetadata(PUBLIC, true);

/**
 * Route utilisable avec un mot de passe provisoire (profil, changement de mot
 * de passe, déconnexion). Toutes les autres sont bloquées tant qu'il n'est pas changé.
 */
export const AllowPendingPassword = () => SetMetadata(PENDING_PASSWORD_OK, true);

/** Restreint la route aux rôles de la permission (voir shared/roles.ts). */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION, p);

export type AuthedRequest = Request & { user?: AuthUser; token?: string };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new UnauthorizedException();
  return user;
});

export function bearerToken(req: Request): string | undefined {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/** Garde globale : connexion obligatoire par défaut, puis contrôle du rôle. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req);
    if (!token) throw new UnauthorizedException('Connexion requise');
    req.user = await this.auth.authenticate(token);
    req.token = token;

    if (req.user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(PENDING_PASSWORD_OK, targets)) {
      throw new ForbiddenException('Changez votre mot de passe provisoire pour continuer');
    }

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, targets);
    if (permission && !(permissions[permission] as readonly string[]).includes(req.user.role)) {
      throw new ForbiddenException('Votre rôle ne permet pas cette action');
    }
    return true;
  }
}
