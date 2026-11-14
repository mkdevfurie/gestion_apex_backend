import { Controller, Get, Header, Query } from '@nestjs/common';
import { RequirePermission } from '../auth/auth.guard.js';
import { canonicalPayments, hashOf } from '../pos/documents.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { periodSchema, stockStatus, type Period } from '../shared/index.js';
import { resolvePeriod } from './reports.service.js';

/**
 * Cellule CSV sûre : séparateur « ; » (Excel en français) et neutralisation de
 * l'injection de formules (=, +, -, @ en tête d'un texte → préfixe apostrophe).
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
  let s =
    v instanceof Date
      ? v.toISOString().replace('T', ' ').slice(0, 16)
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v as string | boolean | bigint);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** BOM UTF-8 : Excel reconnaît les accents. */
export const toCsv = (header: string[], rows: unknown[][]) =>
  '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

const dispo = (name: string) => `attachment; filename="${name}"`;

@Controller('exports')
@RequirePermission('viewReports')
export class ExportsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('sales.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', dispo('ventes.csv'))
  async sales(@Query({ schema: periodSchema }) q: Period) {
    const { start, end } = resolvePeriod(q);
    const rows = await this.prisma.invoice.findMany({
      where: { status: 'ISSUED', kind: { in: ['TICKET', 'INVOICE', 'CREDIT_NOTE'] }, issuedAt: { gte: start, lt: end } },
      include: { user: { select: { name: true } }, customer: { select: { name: true } }, warehouse: { select: { code: true } } },
      orderBy: { issuedAt: 'asc' },
    });
    return toCsv(
      ['Numéro', 'Date', 'Type', 'Dépôt', 'Vendeur', 'Client', 'HT', 'TVA', 'TTC', 'Payé', 'Reste dû'],
      rows.map((r) => {
        const sign = r.kind === 'CREDIT_NOTE' ? -1 : 1;
        return [
          r.number, r.issuedAt, r.kind === 'CREDIT_NOTE' ? 'Avoir' : r.kind === 'INVOICE' ? 'Facture' : 'Ticket', r.warehouse.code,
          r.user.name, r.customer?.name ?? '', sign * (r.subtotal - r.discount), sign * r.vatTotal, sign * r.total,
          sign * r.amountPaid, r.kind === 'CREDIT_NOTE' ? 0 : r.total - r.amountPaid,
        ];
      }),
    );
  }

  @Get('stock.csv')
  @RequirePermission('viewCosts')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', dispo('stock.csv'))
  async stock() {
    const products = await this.prisma.product.findMany({
      where: { active: true },
      include: { category: { select: { name: true } }, stockLevels: { select: { quantity: true } } },
      orderBy: { name: 'asc' },
    });
    return toCsv(
      ['SKU', 'Désignation', 'Catégorie', 'Unité', 'Stock', 'Seuil', 'État', 'PMP', 'Valeur stock', 'Prix vente HT', 'Emplacement'],
      products.map((p) => {
        const qty = p.stockLevels.reduce((a, l) => a + l.quantity.toNumber(), 0);
        const st = stockStatus(qty, p.alertThreshold.toNumber());
        return [
          p.sku, p.name, p.category?.name ?? '', p.unit, qty, p.alertThreshold.toNumber(),
          st === 'OUT' ? 'Rupture' : st === 'LOW' ? 'Stock bas' : 'En stock',
          p.averageCost, Math.round(Math.max(qty, 0) * p.averageCost), p.salePrice, p.location ?? '',
        ];
      }),
    );
  }

  @Get('receivables.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', dispo('creances.csv'))
  async receivables() {
    const open = await this.prisma.invoice.findMany({
      where: { status: 'ISSUED', kind: { in: ['TICKET', 'INVOICE'] }, customerId: { not: null }, amountPaid: { lt: this.prisma.invoice.fields.total } },
      include: { customer: { select: { code: true, name: true, phone: true } } },
      orderBy: [{ dueDate: 'asc' }],
    });
    const now = new Date();
    return toCsv(
      ['Client', 'Code', 'Téléphone', 'Document', 'Date', 'Échéance', 'Total', 'Payé', 'Reste dû', 'Jours de retard'],
      open.map((i) => [
        i.customer!.name, i.customer!.code, i.customer!.phone ?? '', i.number, i.issuedAt, i.dueDate, i.total, i.amountPaid,
        i.total - i.amountPaid, i.dueDate && i.dueDate < now ? Math.floor((now.getTime() - i.dueDate.getTime()) / 86_400_000) : 0,
      ]),
    );
  }

  @Get('purchases.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', dispo('achats.csv'))
  async purchases(@Query({ schema: periodSchema }) q: Period) {
    const { start, end } = resolvePeriod(q);
    const rows = await this.prisma.purchase.findMany({
      where: { status: 'ISSUED', receivedAt: { gte: start, lt: end } },
      include: { supplier: { select: { name: true } }, user: { select: { name: true } } },
      orderBy: { receivedAt: 'asc' },
    });
    return toCsv(
      ['Numéro', 'Date', 'Fournisseur', 'Réf. fournisseur', 'Saisi par', 'Total', 'Payé', 'Reste dû', 'Échéance'],
      rows.map((p) => [p.number, p.receivedAt, p.supplier.name, p.supplierRef ?? '', p.user.name, p.total, p.amountPaid, p.total - p.amountPaid, p.dueDate]),
    );
  }

  @Get('audit.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', dispo('journal.csv'))
  async audit(@Query({ schema: periodSchema }) q: Period) {
    const { start, end } = resolvePeriod(q);
    const rows = await this.prisma.auditLog.findMany({
      where: { createdAt: { gte: start, lt: end } },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });
    return toCsv(['Date', 'Utilisateur', 'Action', 'Objet', 'Détail'], rows.map((r) => [r.createdAt, r.user?.name ?? 'Système', r.action, r.entity, JSON.stringify(r.data ?? {})]));
  }

  /**
   * Vérifie la chaîne d'empreintes : chaque pièce pointe sur la précédente et
   * son empreinte recalculée correspond. Une modification en base est détectée.
   */
  @Get('chain-verify')
  @RequirePermission('manageSettings')
  async verify() {
    const docs = await this.prisma.invoice.findMany({
      where: { chainIndex: { not: null } },
      orderBy: { chainIndex: 'asc' },
      include: {
        lines: { orderBy: { position: 'asc' }, include: { product: { select: { sku: true } } } },
        payments: { where: { atIssue: true }, orderBy: { id: 'asc' } },
      },
    });
    let previous: string | null = null;
    for (const [i, d] of docs.entries()) {
      const expectedIndex = i + 1;
      const issuedAt = d.issuedAt!;
      // Seuls les règlements faits à l'émission entrent dans l'empreinte (atIssue).
      const paid = d.kind === 'CREDIT_NOTE' ? [] : d.payments.map((p) => [p.method, p.amount] as (string | number)[]);
      const base = {
        previousHash: d.previousHash,
        chainIndex: d.chainIndex!,
        number: d.number!,
        issuedAt: issuedAt.toISOString(),
        total: d.total,
        lines: d.lines.map((l) => [l.product?.sku ?? null, l.quantity.toNumber(), l.unitPrice, l.discountRate.toNumber(), l.vatRate.toNumber(), l.lineTotal]),
      };
      // Ordre canonique (version actuelle) ou ordre d'insertion (tickets antérieurs).
      const matches = d.hash === hashOf({ ...base, payments: canonicalPayments(paid) }) || d.hash === hashOf({ ...base, payments: paid });
      const problem =
        d.chainIndex !== expectedIndex ? 'maillon manquant' : d.previousHash !== previous ? 'lien rompu' : !matches ? 'contenu modifié' : null;
      if (problem) return { ok: false, checked: i, brokenAt: d.number, problem };
      previous = d.hash;
    }
    return { ok: true, checked: docs.length, brokenAt: null, problem: null };
  }
}
