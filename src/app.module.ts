import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { StockModule } from './stock/stock.module.js';
import { UsersModule } from './users/users.module.js';
import { PosModule } from './pos/pos.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    CatalogModule,
    StockModule,
    UsersModule,
    PosModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
