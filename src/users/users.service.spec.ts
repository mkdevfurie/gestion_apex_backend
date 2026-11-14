import { verifyPassword } from '../auth/password.js';
import type { AuthUser } from '../shared/index.js';
import { UsersService } from './users.service.js';

const admin: AuthUser = { id: 'a1', email: 'admin@test.sn', name: 'Admin', role: 'ADMIN', mustChangePassword: false };
const row = (over: object = {}) => ({
  id: 'u2',
  email: 'awa@test.sn',
  name: 'Awa',
  role: 'ADMIN',
  active: true,
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: new Date('2026-11-14T10:00:00Z'),
  ...over,
});

function setup() {
  const tx = {
    user: { findUnique: vi.fn(), count: vi.fn(), update: vi.fn(), create: vi.fn() },
    session: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = { $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { tx, service: new UsersService(prisma as never) };
}

describe('UsersService', () => {
  it('crée un compte avec un mot de passe provisoire valable et à changer', async () => {
    const { tx, service } = setup();
    tx.user.create.mockImplementation(({ data }) => Promise.resolve({ ...row(), ...data }));
    const res = await service.create({ name: 'Awa', email: 'awa@test.sn', role: 'CASHIER' }, admin);

    expect(res.temporaryPassword).toMatch(/^[\w]{4}-[\w]{4}-[\w]{4}$/);
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(true);
    expect(data.passwordHash).not.toContain(res.temporaryPassword);
    await expect(verifyPassword(res.temporaryPassword, data.passwordHash)).resolves.toBe(true);
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it("interdit de se désactiver soi-même ou de changer son propre rôle", async () => {
    const { service } = setup();
    await expect(service.update(admin.id, { active: false }, admin)).rejects.toThrow('propre compte');
    await expect(service.update(admin.id, { role: 'CASHIER' }, admin)).rejects.toThrow('propre rôle');
  });

  it('garde toujours au moins un administrateur actif', async () => {
    const { tx, service } = setup();
    tx.user.findUnique.mockResolvedValue(row());
    tx.user.count.mockResolvedValue(0);
    await expect(service.update('u2', { role: 'MANAGER' }, admin)).rejects.toThrow('au moins un administrateur');
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('désactiver ferme immédiatement les sessions du compte', async () => {
    const { tx, service } = setup();
    tx.user.findUnique.mockResolvedValue(row({ role: 'CASHIER' }));
    tx.user.update.mockResolvedValue(row({ role: 'CASHIER', active: false }));
    await service.update('u2', { active: false }, admin);
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u2' } });
  });

  it('réinitialiser : nouveau provisoire et sessions fermées ; pas pour soi-même', async () => {
    const { tx, service } = setup();
    tx.user.findUnique.mockResolvedValue({ id: 'u2' });
    tx.user.update.mockResolvedValue(row({ mustChangePassword: true }));
    const res = await service.resetPassword('u2', admin);
    expect(res.user.mustChangePassword).toBe(true);
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u2' } });
    await expect(service.resetPassword(admin.id, admin)).rejects.toThrow('votre propre compte');
  });
});
