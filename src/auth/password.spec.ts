import { hashPassword, verifyPassword } from './password.js';

describe('mots de passe (scrypt)', () => {
  it('vérifie le bon mot de passe et refuse le mauvais', async () => {
    const hash = await hashPassword('Thiaroye2026');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(hash).not.toContain('Thiaroye2026');
    await expect(verifyPassword('Thiaroye2026', hash)).resolves.toBe(true);
    await expect(verifyPassword('thiaroye2026', hash)).resolves.toBe(false);
  });

  it('sale chaque empreinte différemment', async () => {
    expect(await hashPassword('MemeMotDePasse1')).not.toBe(await hashPassword('MemeMotDePasse1'));
  });

  it('refuse un compte sans mot de passe (« ! ») ou un format inconnu', async () => {
    await expect(verifyPassword('', '!')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$abc')).resolves.toBe(false);
  });
});
