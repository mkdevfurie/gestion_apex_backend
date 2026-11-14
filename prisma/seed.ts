/**
 * Données de démonstration : `pnpm db:seed` (idempotent : ne fait rien si des
 * articles existent déjà).
 *
 * Le stock initial est créé par de VRAIS mouvements (réceptions, ventes,
 * pertes, transfert) via applyMovement : le journal et le PMP sont cohérents.
 */
import 'dotenv/config';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { applyMovement, applyTransfer } from '../src/stock/apply-movement.js';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL manquant (voir .env.example)');
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: url }) });

type Seed = {
  sku: string;
  name: string;
  category: string;
  unit: string;
  cost: number;
  price: number; // HT
  threshold: number;
  location: string;
  received: number; // réception initiale (0 = jamais stocké)
  sold?: number;
  lost?: number;
};

const CATALOG: Seed[] = [
  { sku: 'MAT-CIM-425', name: 'Ciment Portland CEM II 42,5R', category: 'Matériaux', unit: 'sac 50 kg', cost: 4250, price: 4400, threshold: 50, location: 'Allée A-04', received: 500, sold: 60 },
  { sku: 'MAT-FER-012', name: 'Fer à béton TOR Ø12 mm L=12 m', category: 'Matériaux', unit: 'barre 12 m', cost: 5800, price: 6100, threshold: 100, location: 'Parc extérieur C', received: 900, sold: 50 },
  { sku: 'MAT-FER-008', name: 'Fer à béton TOR Ø8 mm L=12 m', category: 'Matériaux', unit: 'barre 12 m', cost: 2600, price: 2750, threshold: 100, location: 'Parc extérieur C', received: 140, sold: 80 },
  { sku: 'MAT-SAB-001', name: 'Sable de dune lavé', category: 'Matériaux', unit: 'm³', cost: 9000, price: 10500, threshold: 5, location: 'Parc extérieur A', received: 24.5, sold: 6.25 },
  { sku: 'PEI-ACR-015', name: 'Peinture acrylique satinée blanc 15 L', category: 'Peinture', unit: 'pot 15 L', cost: 18500, price: 20300, threshold: 15, location: 'Rayon B-12', received: 20, sold: 10, lost: 2 },
  { sku: 'PEI-GLY-004', name: 'Peinture glycéro brillante 4 L', category: 'Peinture', unit: 'pot 4 L', cost: 9500, price: 10800, threshold: 10, location: 'Rayon B-10', received: 30, sold: 4 },
  { sku: 'PLO-VAN-032', name: "Vanne d'arrêt laiton Ø32 quart de tour", category: 'Plomberie', unit: 'pièce', cost: 3100, price: 3800, threshold: 20, location: 'Casier C-08', received: 12, sold: 12 },
  { sku: 'PLO-PVC-100', name: 'Tube PVC évacuation Ø100 L=4 m', category: 'Plomberie', unit: 'barre 4 m', cost: 3400, price: 3900, threshold: 30, location: 'Parc extérieur B', received: 160, sold: 20 },
  { sku: 'OUT-PER-850', name: 'Perforateur burineur SDS-Plus 850 W', category: 'Outillage', unit: 'pièce', cost: 62000, price: 72000, threshold: 5, location: 'Armoire sécurisée 1', received: 36, sold: 2 },
  { sku: 'OUT-BRO-090', name: 'Brouette renforcée 90 L', category: 'Outillage', unit: 'pièce', cost: 21000, price: 24500, threshold: 4, location: 'Allée D-02', received: 6, sold: 3 },
  { sku: 'ELE-CAB-025', name: 'Câble rigide 2,5 mm² — rouleau 100 m', category: 'Électricité', unit: 'rouleau', cost: 24000, price: 27500, threshold: 10, location: 'Rayon E-03', received: 45, sold: 3 },
  { sku: 'ELE-DIS-016', name: 'Disjoncteur divisionnaire 16 A', category: 'Électricité', unit: 'pièce', cost: 2900, price: 3500, threshold: 20, location: 'Casier E-11', received: 80, sold: 5 },
  { sku: 'QUI-VIS-640', name: 'Vis à bois 6×40 — boîte de 200', category: 'Quincaillerie', unit: 'boîte', cost: 2200, price: 2700, threshold: 15, location: 'Casier F-02', received: 0 },
];

async function main() {
  if ((await prisma.product.count()) > 0) {
    console.log('Des articles existent déjà : seed ignoré.');
    return;
  }

  await prisma.company.upsert({
    where: { id: 1 },
    create: { id: 1, name: 'Quincaillerie de démonstration', legalForm: 'SARL', address: 'Rufisque, Dakar', currency: 'XOF' },
    update: {},
  });

  // Connexion désactivée ('!') tant que le module d'authentification n'existe pas.
  const admin = await prisma.user.upsert({
    where: { email: 'admin@apex.local' },
    create: { email: 'admin@apex.local', name: 'Administrateur', passwordHash: '!', role: 'ADMIN' },
    update: {},
  });

  const main = await prisma.warehouse.upsert({
    where: { code: 'DEP-01' },
    create: { code: 'DEP-01', name: 'Dépôt principal', address: 'Rufisque' },
    update: {},
  });
  const annex = await prisma.warehouse.upsert({
    where: { code: 'ANX-01' },
    create: { code: 'ANX-01', name: 'Annexe Thiaroye', address: 'Thiaroye-sur-Mer' },
    update: {},
  });

  const categories = new Map<string, string>();
  for (const name of new Set(CATALOG.map((p) => p.category))) {
    const c = await prisma.category.upsert({ where: { name }, create: { name }, update: {} });
    categories.set(name, c.id);
  }

  for (const s of CATALOG) {
    const product = await prisma.product.create({
      data: {
        sku: s.sku,
        name: s.name,
        categoryId: categories.get(s.category),
        unit: s.unit,
        salePrice: s.price,
        alertThreshold: s.threshold,
        location: s.location,
      },
    });

    await prisma.$transaction(
      async (tx) => {
        const base = { productId: product.id, warehouseId: main.id, userId: admin.id };
        if (s.received > 0) {
          await applyMovement(tx, { ...base, type: 'PURCHASE_RECEIPT', quantity: s.received, unitCost: s.cost, reason: 'Stock initial' });
        }
        if (s.sku === 'MAT-CIM-425') {
          // Deuxième arrivage plus cher : le PMP doit bouger.
          await applyMovement(tx, { ...base, type: 'PURCHASE_RECEIPT', quantity: 200, unitCost: 4400, reason: 'BL CIMENTERIE 7718' });
          await applyTransfer(tx, { productId: product.id, fromWarehouseId: main.id, toWarehouseId: annex.id, quantity: 120, userId: admin.id, reason: 'Réassort annexe' });
        }
        if (s.sold) await applyMovement(tx, { ...base, type: 'SALE', quantity: s.sold, reason: 'Ventes comptoir' });
        if (s.lost) await applyMovement(tx, { ...base, type: 'LOSS', quantity: s.lost, reason: 'Pots percés à la livraison' });
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    console.log(`  ✓ ${s.sku}`);
  }

  console.log(`Seed terminé : ${CATALOG.length} articles, 2 dépôts.`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
