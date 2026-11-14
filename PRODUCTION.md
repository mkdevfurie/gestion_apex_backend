# Mise en production — Apex Ledger

Ce guide liste ce qu'il faut faire **une fois** pour exploiter l'application en
conditions réelles, et ce qu'il faut surveiller ensuite.

## 1. Base de données (Neon)

### Branche de développement (à faire avant tout test)

Ne testez jamais sur la base de production. Neon permet de créer une copie
instantanée :

1. Neon → votre projet → **Branches** → **Create branch**.
2. Nom : `dev`, parent : `main` (ou la branche de production), « Current data ».
3. **Connect** sur la branche `dev` → copiez les deux URL (pooled et direct).
4. Mettez-les dans le `.env` **local** (`DATABASE_URL` / `DIRECT_URL`).
   Le `.env` de production ne doit exister que dans Render.

Pour repartir d'une copie fraîche : branche `dev` → **Reset from parent**.

### Sauvegardes et restauration

- Neon garde un historique (Point-in-time restore). Plan gratuit : 24 h
  (vérifiez la durée de votre plan). **Passez à un plan payant** pour avoir
  au moins 7 jours en production.
- Restaurer : Neon → **Restore** → choisir la date/heure → restaurer dans une
  **nouvelle branche** d'abord, vérifier, puis basculer.
- Sauvegarde hors Neon, à faire chaque semaine (ou via une tâche planifiée) :

```bash
pg_dump "$DIRECT_URL" --format=custom --no-owner --file=apex-$(date +%F).dump
```

  Conservez ces fichiers hors de l'ordinateur de la boutique (disque externe,
  stockage cloud chiffré). Restauration : `pg_restore --no-owner -d "<url>" apex-AAAA-MM-JJ.dump`.
- Les exports CSV de la console admin (ventes, stock, créances…) servent au
  comptable, **pas** de sauvegarde.

## 2. API (Render)

- **Plan payant obligatoire** : en plan gratuit, le service s'endort après
  15 min et la caisse attend ~50 s au réveil. Le plan « Starter » garde l'API
  éveillée.
- Build : `pnpm install --frozen-lockfile && pnpm build && pnpm exec prisma migrate deploy`
- Démarrage : `pnpm start:prod`
- Health check path : `/api/health`
- Variables d'environnement :

| Variable       | Valeur                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL` | URL **pooled** Neon (branche de production), avec `sslmode=verify-full`                 |
| `DIRECT_URL`   | URL **directe** Neon (pour les migrations), avec `sslmode=verify-full`                  |
| `WEB_ORIGIN`   | URL publiques exactes, séparées par des virgules : front employés + console admin      |
| `TRUST_PROXY`  | `1` (Render est devant l'API : nécessaire pour l'IP réelle et la limitation de débit)    |
| `NODE_ENV`     | `production`                                                                            |

Les migrations s'appliquent à chaque déploiement (`migrate deploy`) : elles
ne détruisent jamais de données existantes sans migration explicite.

## 3. Fronts (Vercel)

- Front employés : variable `VITE_API_URL=https://<api>.onrender.com/api`.
- Console admin : `src/environments/environment.ts` → `apiBaseUrl`.
- Après un changement de domaine, mettez à jour `WEB_ORIGIN` sur Render.

## 4. Premier démarrage

1. Créez le compte administrateur : `pnpm user:create` (en local, pointé sur
   la base de production **une seule fois**, ou via le shell Render).
2. Connectez-vous à la console admin → **Société & paramètres** : raison
   sociale, NINEA, RCCM, adresse (imprimés sur tickets et factures), TVA,
   remise maximale, tolérance de caisse, délai de paiement, validité des devis.
3. **Dépôts**, puis **Utilisateurs** : un compte par personne (jamais de
   compte partagé). Chaque employé choisit son mot de passe à la 1re connexion.
4. Catalogue, puis stock initial par **réception fournisseur** ou **inventaire**.
5. Supprimez les comptes de test et changez le mot de passe de test de l'admin.

## 5. Sécurité en place

- Mots de passe : scrypt (sel unique), 10 caractères minimum, provisoires à changer.
- Sessions : jeton opaque haché en base (SHA-256), révocable (changement de
  mot de passe, désactivation, « Couper les sessions », liste des appareils).
- Verrouillage : 8 échecs → compte bloqué 15 min, message d'erreur générique.
- Limitation de débit : 600 requêtes/min/IP, 5 connexions/min sur `/auth/login`.
- Permissions vérifiées **côté serveur** à chaque route (les écrans ne font
  que masquer). Coûts d'achat masqués aux caissiers.
- En-têtes `helmet` (CSP stricte, HSTS…), CORS limité à `WEB_ORIGIN`,
  corps JSON ≤ 1 Mo, montants ≤ 2 milliards, quantités ≤ 1 million.
- Validation Zod de toutes les entrées ; requêtes Prisma paramétrées.
- Exports CSV protégés contre l'injection de formules Excel.
- Pièces de vente (tickets, factures, avoirs) numérotées sans trou et
  **chaînées par empreinte** : console admin → **Exports & contrôle** →
  « Vérifier la chaîne » détecte toute modification directe en base.
- Journal d'audit de toutes les écritures (qui, quoi, quand, IP).
- CI GitHub Actions : typecheck, lint, tests, build, `pnpm audit`.

## 6. Routine

| Fréquence      | Action                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| Chaque jour    | Clôture de chaque caisse (ticket Z), regarder les écarts en alerte      |
| Chaque semaine | `pg_dump`, revue du journal d'activité, relance des créances échues     |
| Chaque mois    | Exports CSV pour le comptable, « Vérifier la chaîne », inventaire tournant |
| Chaque trimestre | Revue des comptes utilisateurs (départs), mises à jour des dépendances |

## 7. Ce que l'application ne fait pas (à savoir)

- Pas de télé-déclaration fiscale (DGID) : le comptable reprend les exports.
- Caisse hors ligne : les ventes **comptant** sont mises en file sur
  l'appareil et envoyées au retour du réseau ; le numéro définitif est
  attribué à l'envoi. Les ventes à crédit exigent le réseau.
