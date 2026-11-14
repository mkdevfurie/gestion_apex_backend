# Gestion Apex — API

API de gestion commerciale pour boutiques, quincailleries et grossistes au Sénégal :
stock, caisse, factures, créances clients et dettes fournisseurs (FCFA, Wave, Orange Money).

**Stack** : NestJS 12 (ESM) · Prisma 7 · PostgreSQL (Neon) · Zod · Vitest

Dépôts liés :

- Front (caisse, stock, factures) — [gestion_apex_teste](https://github.com/mkdevfurie/gestion_apex_teste)
- Dashboard admin (Angular) — [gestion_apex_admin](https://github.com/mkdevfurie/gestion_apex_admin)

## Démarrage

```bash
corepack enable pnpm          # une seule fois
pnpm install                  # génère aussi le client Prisma
cp .env.example .env          # puis coller les URL Neon
pnpm prisma:migrate           # crée / met à jour les tables
pnpm db:seed                  # données de démo (2 dépôts, 13 articles, mouvements)
pnpm user:create              # crée votre compte administrateur (mot de passe masqué)
pnpm dev                      # http://localhost:3001/api/health
```

| Variable       | Rôle                                                              |
| -------------- | ----------------------------------------------------------------- |
| `DATABASE_URL` | Connexion Neon **poolée** (hôte `-pooler`), utilisée par l'app    |
| `DIRECT_URL`   | Connexion Neon directe, utilisée par `prisma migrate`             |
| `PORT`         | Port HTTP (3001 par défaut)                                       |
| `WEB_ORIGIN`   | Origines CORS autorisées, séparées par des virgules               |
| `TRUST_PROXY`  | Nombre de proxys devant l'API (Render : 1, local : 0)             |

## Règles métier non négociables

1. **Stock = somme des mouvements.** On n'écrit jamais une quantité directement :
   chaque entrée/sortie est un `StockMovement` immuable. `StockLevel` est un cache.
2. **Une facture émise est scellée.** Toute correction passe par un avoir.
3. **Créance = total facture − Σ règlements.** Pas de table « dette ».
4. **Montants en FCFA entiers**, quantités en `Decimal(14,3)`.
5. Les totaux sont calculés par `computeInvoiceTotals` (`src/shared`).
   L'escompte est déduit de la base HT **avant** la TVA.

## Authentification

- `POST /auth/login` → jeton de session (256 bits aléatoires). **Seule son
  empreinte SHA-256 est stockée** (table `Session`) : supprimer la ligne
  déconnecte. Expiration après 12 h d'inactivité.
- Toutes les routes exigent `Authorization: Bearer <jeton>`, sauf `/health`
  et `/auth/login` (garde globale `AuthGuard`).
- Mots de passe : scrypt (N=2¹⁵), comparaison à temps constant ; même réponse
  pour un e-mail inconnu, un mauvais mot de passe ou un compte désactivé.
- 5 tentatives de connexion par minute et par IP (429 au-delà).
- Rôles vérifiés côté API (`src/shared/roles.ts`, partagé avec les interfaces) :

| Action                                   | Rôles                          |
| ---------------------------------------- | ------------------------------ |
| Lire catalogue, stock, journal           | tous les utilisateurs connectés |
| Créer / modifier articles et catégories  | Administrateur, Gérant         |
| Réceptions, pertes, inventaires, transferts | Administrateur, Gérant, Magasinier |
| Dashboard d'administration               | Administrateur, Gérant         |

Comptes :

- **Premier administrateur** : `pnpm user:create` (mot de passe choisi, saisi masqué).
- **Employés** : créés par un administrateur dans le dashboard admin
  (« Utilisateurs & rôles »). Un mot de passe **provisoire** est généré et
  affiché une seule fois ; l'API bloque tout le reste tant qu'il n'est pas changé.
- **Secours** (administrateur bloqué) : `pnpm user:reset-password <e-mail>`
  donne un mot de passe provisoire et ferme les sessions.
- Un compte n'est jamais supprimé, il est **désactivé** (déconnexion immédiate) ;
  il reste toujours au moins un administrateur actif.

| Méthode | Route                       | Rôle requis        |
| ------- | --------------------------- | ------------------ |
| GET     | `/users`                    | Administrateur, Gérant |
| POST    | `/users`                    | Administrateur     |
| PATCH   | `/users/:id`                | Administrateur (nom, rôle, actif) |
| POST    | `/users/:id/reset-password` | Administrateur     |
| POST    | `/auth/password`            | soi-même           |

## Déploiement (Render)

- Commande de build : `pnpm install && pnpm build && pnpm exec prisma migrate deploy`
  (`pnpm build` génère lui-même le client Prisma, ignoré par git)
- Commande de démarrage : `pnpm start:prod`
- Variables : `DATABASE_URL`, `DIRECT_URL` (avec `sslmode=verify-full`),
  `WEB_ORIGIN` (URL publiques du front et de l'admin), `TRUST_PROXY=1`.

## Endpoints (préfixe `/api`)

| Méthode | Route                  | Rôle                                                              |
| ------- | ---------------------- | ----------------------------------------------------------------- |
| GET     | `/health`              | État de l'API et de la base                                       |
| GET     | `/warehouses`          | Dépôts actifs                                                     |
| GET/POST| `/categories`          | Catégories (avec nombre d'articles)                               |
| GET     | `/products`            | Catalogue paginé : `q`, `categoryId`, `warehouseId`, `status` (OK/LOW/OUT) + indicateurs |
| GET     | `/products/:id`        | Fiche : stock par dépôt, 20 derniers mouvements                   |
| POST    | `/products`            | Création (stock à 0)                                              |
| PATCH   | `/products/:id`        | Modification de la fiche — **jamais** du stock ni du PMP          |
| GET     | `/stock/movements`     | Journal immuable, filtrable par article, dépôt, type              |
| POST    | `/stock/movements`     | Réception (recalcule le PMP), retour client, perte, retour fournisseur |
| POST    | `/stock/inventory`     | Quantité comptée → ajustement de l'écart                          |
| POST    | `/stock/transfers`     | Sortie + entrée liées entre deux dépôts                           |

Toute écriture de stock passe par `applyMovement` (`src/stock/apply-movement.ts`) :
verrou `FOR UPDATE` sur l'article, refus du stock négatif (409), PMP recalculé
à la réception, mouvement + cache `StockLevel` + journal d'audit dans la même
transaction. Les ventes (`SALE`) ne se saisissent pas à la main : elles viendront
de la caisse.

> **Neon** met la base en veille après quelques minutes d'inactivité : la
> première requête peut prendre quelques secondes (transactions : `maxWait` 10 s).
> L'API utilise le pilote `pg` (TCP) : les connexions inactives sont libérées
> après 60 s, avant que Neon ne les coupe.

## Code partagé

`src/shared` (calculs de totaux/TVA, PMP, état du stock, `formatXof`, schémas Zod) existe aussi dans
le front et l'admin. **Toute modification doit être reportée dans les trois dépôts.**

## Commandes

```bash
pnpm build | pnpm typecheck | pnpm lint
pnpm test          # tests unitaires (dont calculs de facture)
pnpm test:e2e      # tests HTTP
pnpm prisma:studio # explorer la base
```
