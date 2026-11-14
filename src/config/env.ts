import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().default(3001),
  /** Origines autorisées (CORS), séparées par des virgules : front + admin. */
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:5173,http://localhost:4300')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Variables d'environnement invalides (voir .env.example) :\n${details}`,
    );
  }
  return parsed.data;
}
