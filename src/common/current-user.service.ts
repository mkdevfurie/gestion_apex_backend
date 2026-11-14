import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * TEMPORAIRE — en attendant le module d'authentification.
 * Chaque mouvement de stock doit être signé par un utilisateur : on utilise
 * le premier administrateur actif (créé par `pnpm db:seed`).
 */
@Injectable()
export class CurrentUserService {
  private cachedId: string | undefined;

  constructor(private readonly prisma: PrismaService) {}

  async id(): Promise<string> {
    if (this.cachedId) return this.cachedId;
    const admin = await this.prisma.user.findFirst({
      where: { role: 'ADMIN', active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!admin) {
      throw new ServiceUnavailableException(
        'Aucun administrateur en base : lancez `pnpm db:seed`.',
      );
    }
    this.cachedId = admin.id;
    return admin.id;
  }
}
