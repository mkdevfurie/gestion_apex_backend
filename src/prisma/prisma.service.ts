import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { prismaOptions } from './adapter.js';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super(prismaOptions(config.get('DATABASE_URL', { infer: true })));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
