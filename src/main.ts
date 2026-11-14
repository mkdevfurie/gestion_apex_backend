import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

// Messages de validation en français (renvoyés tels quels au front).
z.config(z.locales.fr());

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Derrière le proxy de Render : req.ip = adresse du client (limite de tentatives).
  app.getHttpAdapter().getInstance().set('trust proxy', config.get('TRUST_PROXY', { infer: true }));

  app.setGlobalPrefix('api');
  // Valide @Body/@Query/@Param({ schema }) avec les schémas Zod partagés.
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableCors({ origin: config.get('WEB_ORIGIN', { infer: true }) });
  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
