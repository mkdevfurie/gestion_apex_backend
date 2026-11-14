/**
 * Donne un mot de passe PROVISOIRE à un compte existant (à changer à la
 * première connexion) et ferme ses sessions. Secours si le seul
 * administrateur a oublié son mot de passe.
 *
 *   pnpm user:reset-password admin@exemple.sn
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { generateTemporaryPassword, hashPassword } from '../src/auth/password.js';
import { prismaOptions } from '../src/prisma/adapter.js';
import { loginInputSchema, roleLabels } from '../src/shared/index.js';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL manquant (voir .env.example)');
const prisma = new PrismaClient(prismaOptions(url));

try {
  const email = loginInputSchema.shape.email.safeParse(process.argv[2] ?? '');
  if (!email.success) throw new Error('Usage : pnpm user:reset-password <e-mail>');

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { email: email.data },
      data: { passwordHash, mustChangePassword: true, active: true },
    });
    await tx.session.deleteMany({ where: { userId: u.id } });
    await tx.auditLog.create({
      data: { userId: u.id, action: 'user.password_reset', entity: 'User', entityId: u.id, data: { via: 'cli' } },
    });
    return u;
  });

  console.log(`Compte       : ${user.name} <${user.email}> — ${roleLabels[user.role]}`);
  console.log(`Mot de passe : ${temporaryPassword}   (provisoire, à changer à la première connexion)`);
} catch (e) {
  const msg = (e as { code?: string }).code === 'P2025' ? 'Aucun compte avec cette adresse' : (e as Error).message;
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
