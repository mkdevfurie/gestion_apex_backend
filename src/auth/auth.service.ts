import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser, ChangePasswordInput, LoginInput, LoginResponse } from '../shared/index.js';
import { dummyHash, hashPassword, verifyPassword } from './password.js';

/** Déconnexion après 12 h sans activité (une journée de travail). */
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** On ne réécrit lastUsedAt/expiresAt qu'au plus toutes les 5 min. */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(input: LoginInput, meta: { ip?: string; userAgent?: string }): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()));

    // Même message pour un e-mail inconnu, un mauvais mot de passe ou un compte désactivé.
    if (!user || !ok || !user.active) {
      if (user) {
        await this.prisma.auditLog.create({
          data: { userId: user.id, action: 'auth.login_failed', entity: 'User', entityId: user.id, data: { ip: meta.ip ?? null } },
        });
      }
      throw new UnauthorizedException('E-mail ou mot de passe incorrect');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_IDLE_MS);
    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt,
          ip: meta.ip?.slice(0, 64),
          userAgent: meta.userAgent?.slice(0, 300),
        },
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
      this.prisma.auditLog.create({
        data: { userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id, data: { ip: meta.ip ?? null } },
      }),
      // Ménage opportuniste des sessions expirées de cet utilisateur.
      this.prisma.session.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } }),
    ]);

    return { token, expiresAt: expiresAt.toISOString(), user: toAuthUser(user) };
  }

  /** Renvoie l'utilisateur du jeton, ou lève 401. Prolonge la session active. */
  async authenticate(token: string): Promise<AuthUser> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    const now = Date.now();
    if (!session || session.expiresAt.getTime() <= now || !session.user.active) {
      throw new UnauthorizedException('Session expirée, reconnectez-vous');
    }
    if (now - session.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date(now), expiresAt: new Date(now + SESSION_IDLE_MS) },
      });
    }
    return toAuthUser(session.user);
  }

  async logout(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  }

  /**
   * Changement par l'utilisateur lui-même (obligatoire après un mot de passe
   * provisoire). Ferme toutes ses AUTRES sessions : un appareil oublié ou un
   * mot de passe connu d'un tiers ne donne plus accès.
   */
  async changePassword(userId: string, currentToken: string, input: ChangePasswordInput): Promise<AuthUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new BadRequestException('Mot de passe actuel incorrect');
    }
    const passwordHash = await hashPassword(input.newPassword);
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false } }),
      this.prisma.session.deleteMany({ where: { userId, tokenHash: { not: sha256(currentToken) } } }),
      this.prisma.auditLog.create({
        data: { userId, action: 'auth.password_change', entity: 'User', entityId: userId },
      }),
    ]);
    return toAuthUser(updated);
  }
}

function toAuthUser(u: AuthUser): AuthUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword };
}
