import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Base simulée : ces tests couvrent le routage et la validation HTTP.
// La logique de stock (verrou, PMP, soldes) est testée contre Neon.
describe('API (e2e)', () => {
  let app: INestApplication<App>;
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    warehouse: { findMany: vi.fn().mockResolvedValue([]) },
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

  it('GET /health', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
      });
  });

  it('GET /warehouses', () => {
    return request(app.getHttpServer()).get('/warehouses').expect(200).expect([]);
  });

  it('GET /products/:id refuse un identifiant invalide', () => {
    return request(app.getHttpServer()).get('/products/abc').expect(400);
  });

  it('POST /stock/movements refuse une réception sans coût, sans toucher la base', async () => {
    await request(app.getHttpServer())
      .post('/stock/movements')
      .send({
        type: 'PURCHASE_RECEIPT',
        productId: '01a1d9f6-1e4b-7c4e-9a3b-2f1c8d7e6b5a',
        warehouseId: '01a1d9f6-1e4b-7c4e-9a3b-2f1c8d7e6b5b',
        quantity: 10,
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.message[0]).toContain('unitCost');
      });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('GET /stock/movements refuse un type inconnu', () => {
    return request(app.getHttpServer()).get('/stock/movements?type=VOL').expect(400);
  });
});
