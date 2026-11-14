/**
 * Crée un utilisateur, ou réinitialise son mot de passe s'il existe déjà.
 *
 *   pnpm user:create
 *
 * Le mot de passe est saisi au clavier (masqué) : il n'apparaît ni dans
 * l'historique du terminal ni dans les journaux. Toutes ses sessions ouvertes
 * sont fermées après un changement de mot de passe.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { prismaOptions } from '../src/prisma/adapter.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/auth/password.js';
import { loginInputSchema, newPasswordSchema, roleLabels, roleSchema } from '../src/shared/index.js';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL manquant (voir .env.example)');
const prisma = new PrismaClient(prismaOptions(url));

type Rl = ReturnType<typeof createInterface> & { _writeToOutput?: (s: string) => void };

const rl: Rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

/** Saisie masquée : on n'écrit pas les caractères tapés. */
async function askHidden(q: string): Promise<string> {
  const write = rl._writeToOutput;
  rl._writeToOutput = (s: string) => {
    if (s.includes(q)) process.stdout.write(s);
    else if (s === '\r\n' || s === '\n') process.stdout.write('\n');
  };
  const answer = await ask(q);
  rl._writeToOutput = write;
  process.stdout.write('\n');
  return answer;
}

async function main() {
  console.log('\nApex Ledger — création / réinitialisation d’un utilisateur\n');

  const email = loginInputSchema.shape.email.safeParse(await ask('E-mail : '));
  if (!email.success) throw new Error('Adresse e-mail invalide');

  const existing = await prisma.user.findUnique({ where: { email: email.data } });
  if (existing) console.log(`→ Compte existant (${existing.name}, ${roleLabels[existing.role]}) : réinitialisation.`);

  const name = (await ask(`Nom complet${existing ? ` [${existing.name}]` : ''} : `)).trim() || existing?.name;
  if (!name || name.length < 2) throw new Error('Nom obligatoire');

  const roles = roleSchema.options.map((r, i) => `${i + 1}. ${roleLabels[r]}`).join('   ');
  const defaultRole = existing?.role ?? 'ADMIN';
  const pick = (await ask(`Rôle — ${roles} [${roleLabels[defaultRole]}] : `)).trim();
  const role = pick ? roleSchema.options[Number(pick) - 1] : defaultRole;
  if (!role) throw new Error('Rôle invalide');

  const password = await askHidden('Mot de passe (10 caractères min., lettres et chiffres) : ');
  const check = newPasswordSchema.safeParse(password);
  if (!check.success) throw new Error(check.error.issues.map((i) => i.message).join(', '));
  if ((await askHidden('Confirmer le mot de passe : ')) !== password) {
    throw new Error('Les deux mots de passe ne correspondent pas');
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.upsert({
      where: { email: email.data },
      create: { email: email.data, name, role, passwordHash },
      update: { name, role, passwordHash, active: true, mustChangePassword: false },
    });
    await tx.session.deleteMany({ where: { userId: u.id } });
    await tx.auditLog.create({
      data: { userId: u.id, action: existing ? 'user.password_reset' : 'user.create', entity: 'User', entityId: u.id, data: { role, via: 'cli' } },
    });
    return u;
  });

  console.log(`\n✓ ${user.name} <${user.email}> — ${roleLabels[user.role]}. Vous pouvez vous connecter.`);
}

try {
  await main();
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await prisma.$disconnect();
}
