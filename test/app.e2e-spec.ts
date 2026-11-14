import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { hashPassword } from './../src/auth/password.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Base simulée : ces tests couvrent le routage, l'authentification et la
// validation HTTP. La logique de stock (verrou, PMP, soldes) est testée contre Neon.

const TOKEN = 'jeton-de-test';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const user = (role: string, extra: object = {}) => ({
  id: 'u1',
  email: 'caisse@test.sn',
  name: 'Awa',
  role,
  active: true,
  mustChangePassword: false,
  ...extra,
});
const session = (role: string) => ({
  id: 's1',
  tokenHash: sha(TOKEN),
  lastUsedAt: new Date(),
  expiresAt: new Date(Date.now() + 3_600_000),
  user: user(role),
});

describe('API (e2e)', () => {
  let app: INestApplication<App>;
  const prisma: Record<string, any> = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn().mockResolvedValue([]),
    warehouse: { findMany: vi.fn().mockResolvedValue([]) },
    session: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const as = (role: string) => {
    prisma.session.findUnique.mockImplementation(({ where }: { where: { tokenHash: string } }) =>
      Promise.resolve(where.tokenHash === sha(TOKEN) ? session(role) : null),
    );
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new StandardSchemaValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  const http = () => request(app.getHttpServer());

  it('GET /health est public', () => {
    return http()
      .get('/health')
      .expect(200)
      .expect((res) => expect(res.body).toMatchObject({ status: 'ok', database: 'up' }));
  });

  describe('protection des routes', () => {
    it('refuse sans jeton (401)', () => {
      return http().get('/warehouses').expect(401);
    });

    it('refuse un jeton inconnu (401)', () => {
      as('CASHIER');
      return http().get('/warehouses').set('Authorization', 'Bearer inconnu').expect(401);
    });

    it('refuse une session expirée (401)', () => {
      prisma.session.findUnique.mockResolvedValue({ ...session('ADMIN'), expiresAt: new Date(Date.now() - 1) });
      return http().get('/warehouses').set('Authorization', `Bearer ${TOKEN}`).expect(401);
    });

    it('refuse un compte désactivé (401)', () => {
      prisma.session.findUnique.mockResolvedValue({ ...session('ADMIN'), user: { ...user('ADMIN'), active: false } });
      return http().get('/warehouses').set('Authorization', `Bearer ${TOKEN}`).expect(401);
    });

    it('autorise la lecture à tout utilisateur connecté', () => {
      as('CASHIER');
      return http().get('/warehouses').set('Authorization', `Bearer ${TOKEN}`).expect(200).expect([]);
    });

    it('interdit à un caissier de saisir un mouvement de stock (403)', async () => {
      as('CASHIER');
      await http()
        .post('/stock/movements')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ type: 'LOSS', productId: '01a1d9f6-1e4b-7c4e-9a3b-2f1c8d7e6b5a', warehouseId: '01a1d9f6-1e4b-7c4e-9a3b-2f1c8d7e6b5b', quantity: 1 })
        .expect(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('interdit à un magasinier de créer un article (403)', () => {
      as('STOCK_KEEPER');
      return http()
        .post('/products')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ sku: 'X1', name: 'Article', unit: 'pièce', salePrice: 100 })
        .expect(403);
    });

    it('valide le corps après le contrôle du rôle (400)', async () => {
      as('STOCK_KEEPER');
      await http()
        .post('/stock/movements')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ type: 'PURCHASE_RECEIPT', productId: '01a1d9f6-1e4b-7c4e-9a3b-2f1c8d7e6b5a', warehouseId: '01a1d9f6-1e4b-7c4e-9a3b-2f1c8d7e6b5b', quantity: 10 })
        .expect(400)
        .expect((res) => expect(res.body.message[0]).toContain('unitCost'));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('mot de passe provisoire : tout est bloqué sauf profil et déconnexion', async () => {
      prisma.session.findUnique.mockResolvedValue({ ...session('ADMIN'), user: user('ADMIN', { mustChangePassword: true }) });
      const auth = { Authorization: `Bearer ${TOKEN}` };
      await http()
        .get('/warehouses')
        .set(auth)
        .expect(403)
        .expect((res) => expect(res.body.message).toContain('mot de passe provisoire'));
      await http().get('/auth/me').set(auth).expect(200);
      await http().post('/auth/logout').set(auth).expect(204);
    });

    it('comptes : le gérant consulte, seul l’administrateur crée', async () => {
      as('MANAGER');
      prisma.user.findMany.mockResolvedValue([]);
      const auth = { Authorization: `Bearer ${TOKEN}` };
      await http().get('/users').set(auth).expect(200);
      await http().post('/users').set(auth).send({ name: 'Moussa', email: 'm@test.sn', role: 'CASHIER' }).expect(403);
      as('CASHIER');
      await http().get('/users').set(auth).expect(403);
    });

    it('rapports et journal : réservés au gérant et à l’administrateur (403)', async () => {
      const auth = { Authorization: `Bearer ${TOKEN}` };
      for (const role of ['CASHIER', 'STOCK_KEEPER']) {
        as(role);
        for (const url of ['/reports/overview', '/reports/employees', '/reports/audit', '/reports/sales', '/reports/cash-sessions']) {
          await http().get(url).set(auth).expect(403);
        }
      }
    });

    it('paramètres, société, dépôts : modifiables par l’administrateur seul (403)', async () => {
      const auth = { Authorization: `Bearer ${TOKEN}` };
      as('MANAGER');
      await http().patch('/settings').set(auth).send({ maxDiscountRate: 50 }).expect(403);
      await http().patch('/company').set(auth).send({ name: 'Pirate SARL' }).expect(403);
      await http().post('/warehouses').set(auth).send({ code: 'X-01', name: 'Dépôt X' }).expect(403);
    });

    it('le caissier ne reçoit jamais les coûts d’achat (PMP, valorisation)', async () => {
      as('CASHIER');
      prisma.product = {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'p1', sku: 'X', barcode: null, name: 'Article', category: null, unit: 'pièce', salePrice: 1000,
            vatRate: { toNumber: () => 18 }, averageCost: 700, alertThreshold: { toNumber: () => 0 },
            location: null, active: true, stockLevels: [{ quantity: { toNumber: () => 10 } }],
          },
        ]),
      } as never;
      prisma.stockMovement = { count: vi.fn().mockResolvedValue(0) } as never;
      const res = await http().get('/products').set('Authorization', `Bearer ${TOKEN}`).expect(200);
      expect(res.body.items[0].averageCost).toBe(0);
      expect(res.body.summary.valuation).toBe(0);
      expect(JSON.stringify(res.body)).not.toContain('700');
    });

    it('caisse : interdite au magasinier (403)', () => {
      as('STOCK_KEEPER');
      return http().get('/cash-sessions/current').set('Authorization', `Bearer ${TOKEN}`).expect(403);
    });

    it('GET /stock/movements refuse un type inconnu (400)', () => {
      as('ADMIN');
      return http().get('/stock/movements?type=VOL').set('Authorization', `Bearer ${TOKEN}`).expect(400);
    });
  });

  describe('POST /auth/login', () => {
    it('ouvre une session avec le bon mot de passe', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user('MANAGER'), passwordHash: await hashPassword('Rufisque2026') });
      const res = await http().post('/auth/login').send({ email: ' Caisse@Test.sn ', password: 'Rufisque2026' }).expect(200);
      expect(res.body.user).toEqual({ id: 'u1', email: 'caisse@test.sn', name: 'Awa', role: 'MANAGER', mustChangePassword: false });
      expect(res.body.token).toMatch(/^[\w-]{43}$/);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'caisse@test.sn' } });
      // Seule l'empreinte du jeton est enregistrée.
      expect(prisma.session.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ tokenHash: sha(res.body.token) }) }),
      );
      expect(JSON.stringify(prisma.session.create.mock.calls)).not.toContain(res.body.token);
    });

    it('même réponse pour un mauvais mot de passe et un e-mail inconnu', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ ...user('ADMIN'), passwordHash: await hashPassword('Rufisque2026') });
      const wrong = await http().post('/auth/login').send({ email: 'caisse@test.sn', password: 'mauvais' }).expect(401);
      prisma.user.findUnique.mockResolvedValueOnce(null);
      const unknown = await http().post('/auth/login').send({ email: 'x@test.sn', password: 'mauvais' }).expect(401);
      expect(wrong.body.message).toContain('E-mail ou mot de passe incorrect');
      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('refuse un compte désactivé même avec le bon mot de passe', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user('ADMIN'), active: false, passwordHash: await hashPassword('Rufisque2026') });
      await http().post('/auth/login').send({ email: 'caisse@test.sn', password: 'Rufisque2026' }).expect(401);
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('verrouille le compte au 8e échec consécutif, même depuis plusieurs adresses', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user('CASHIER'), failedLogins: 7, lockedUntil: null, passwordHash: await hashPassword('Rufisque2026') });
      prisma.$transaction.mockImplementation((ops: unknown) => (Array.isArray(ops) ? Promise.resolve([]) : Promise.resolve()));
      await http().post('/auth/login').send({ email: 'caisse@test.sn', password: 'mauvais' }).expect(401);
      const update = prisma.user.update.mock.calls.at(-1)?.[0];
      expect(update.data.failedLogins).toBe(0);
      expect(update.data.lockedUntil.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    });

    it('compte verrouillé : refusé même avec le bon mot de passe', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...user('CASHIER'), failedLogins: 0, lockedUntil: new Date(Date.now() + 600_000), passwordHash: await hashPassword('Rufisque2026'),
      });
      await http().post('/auth/login').send({ email: 'caisse@test.sn', password: 'Rufisque2026' }).expect(401);
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('limite les tentatives à 5 par minute (429)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      for (let i = 0; i < 5; i++) {
        await http().post('/auth/login').send({ email: 'x@test.sn', password: 'x' }).expect(401);
      }
      await http().post('/auth/login').send({ email: 'x@test.sn', password: 'x' }).expect(429);
    });

    it('déconnexion : supprime la session', async () => {
      as('CASHIER');
      await http().post('/auth/logout').set('Authorization', `Bearer ${TOKEN}`).expect(204);
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { tokenHash: sha(TOKEN) } });
    });
  });
});
