import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

// Messages de validation en français (renvoyés tels quels au front).
z.config(z.locales.fr());

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Derrière le proxy de Render : req.ip = adresse du client (limite de tentatives).
  app.getHttpAdapter().getInstance().set('trust proxy', config.get('TRUST_PROXY', { infer: true }));

  // En-têtes de sécurité (HSTS, nosniff, frame-deny…) ; l'API ne sert pas de HTML.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Corps limités : rien d'utile ne dépasse 1 Mo (inventaire complet compris).
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '100kb' }));

  app.setGlobalPrefix('api');
  // Valide @Body/@Query/@Param({ schema }) avec les schémas Zod partagés.
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableCors({
    origin: config.get('WEB_ORIGIN', { infer: true }),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
    credentials: false,
    maxAge: 600,
  });
  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
