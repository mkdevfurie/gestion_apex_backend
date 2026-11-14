import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { PrismaService } from './prisma/prisma.service.js';

describe('AppController', () => {
  let appController: AppController;
  const prisma = { $queryRaw: vi.fn() };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    appController = app.get(AppController);
  });

  it('signale la base comme disponible', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(appController.health()).resolves.toMatchObject({
      status: 'ok',
      database: 'up',
    });
  });

  it('signale la base comme indisponible', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connexion refusée'));
    await expect(appController.health()).resolves.toMatchObject({
      database: 'down',
    });
  });
});
