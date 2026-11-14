import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { generateTemporaryPassword, hashPassword } from '../auth/password.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AuthUser,
  TemporaryPasswordResponse,
  UserCreateInput,
  UserRow,
  UserUpdateInput,
} from '../shared/index.js';

const select = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

type Selected = Prisma.UserGetPayload<{ select: typeof select }>;

const toRow = (u: Selected): UserRow => ({
  ...u,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});

/**
 * Gestion des comptes par un administrateur.
 * On ne supprime jamais un compte : ses ventes et mouvements doivent rester
 * signés. Un départ = désactivation (et fermeture immédiate des sessions).
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<UserRow[]> {
    const users = await this.prisma.user.findMany({
      select,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return users.map(toRow);
  }

  async create(input: UserCreateInput, actor: AuthUser): Promise<TemporaryPasswordResponse> {
    const temporaryPassword = generateTemporaryPassword();
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { ...input, passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true },
          select,
        });
        await this.audit(tx, actor, 'user.create', u.id, { email: u.email, role: u.role });
        return u;
      });
      return { user: toRow(user), temporaryPassword };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Un compte utilise déjà cette adresse e-mail');
      }
      throw e;
    }
  }

  async update(id: string, input: UserUpdateInput, actor: AuthUser): Promise<UserRow> {
    if (id === actor.id) {
      if (input.active === false) throw new BadRequestException('Vous ne pouvez pas désactiver votre propre compte');
      if (input.role && input.role !== actor.role) {
        throw new BadRequestException('Vous ne pouvez pas changer votre propre rôle');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select });
      if (!before) throw new NotFoundException('Compte introuvable');

      // Il doit toujours rester au moins un administrateur actif.
      const losesAdmin =
        before.role === 'ADMIN' && before.active && (input.active === false || (input.role && input.role !== 'ADMIN'));
      if (losesAdmin) {
        const others = await tx.user.count({ where: { role: 'ADMIN', active: true, id: { not: id } } });
        if (others === 0) throw new ConflictException('Il doit rester au moins un administrateur actif');
      }

      const user = await tx.user.update({ where: { id }, data: input, select });
      if (input.active === false) await tx.session.deleteMany({ where: { userId: id } });

      const changes = Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, { from: before[k as keyof UserUpdateInput], to: v }]),
      );
      await this.audit(tx, actor, 'user.update', id, changes);
      return toRow(user);
    });
  }

  /** Nouveau mot de passe provisoire ; ferme toutes les sessions du compte. */
  async resetPassword(id: string, actor: AuthUser): Promise<TemporaryPasswordResponse> {
    if (id === actor.id) {
      throw new BadRequestException('Pour votre propre compte, utilisez « Changer mon mot de passe »');
    }
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const user = await this.prisma.$transaction(async (tx) => {
      const exists = await tx.user.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Compte introuvable');
      const u = await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true }, select });
      await tx.session.deleteMany({ where: { userId: id } });
      await this.audit(tx, actor, 'user.password_reset', id, {});
      return u;
    });
    return { user: toRow(user), temporaryPassword };
  }

  private audit(tx: Prisma.TransactionClient, actor: AuthUser, action: string, entityId: string, data: object) {
    return tx.auditLog.create({
      data: { userId: actor.id, action, entity: 'User', entityId, data: data as Prisma.InputJsonValue },
    });
  }
}
