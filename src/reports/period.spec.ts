import { resolvePeriod } from './reports.service.js';

describe('resolvePeriod', () => {
  it("par défaut : la journée d'aujourd'hui, fin exclue", () => {
    const p = resolvePeriod({});
    expect(p.from).toBe(p.to);
    expect(p.end.getTime() - p.start.getTime()).toBe(86_400_000);
  });

  it('inclut le jour de fin', () => {
    const p = resolvePeriod({ from: '2026-11-01', to: '2026-11-14' });
    expect(p.start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('remet dans l’ordre des dates inversées', () => {
    const p = resolvePeriod({ from: '2026-11-14', to: '2026-11-01' });
    expect([p.from, p.to]).toEqual(['2026-11-01', '2026-11-14']);
  });
});
