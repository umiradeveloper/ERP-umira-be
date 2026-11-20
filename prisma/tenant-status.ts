/**
 * Nonaktifkan / aktifkan kembali satu perusahaan beserta semua user-nya.
 *
 *   npm run tenant:disable -- --slug demo   → perusahaan "demo" tidak bisa login lagi, sesi aktif dicabut
 *   npm run tenant:enable  -- --slug demo   → aktif kembali
 *
 * Data perusahaan tidak dihapus.
 */
import '../src/env';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const mode = process.argv.includes('--enable') ? 'enable' : 'disable';
  const slug = arg('slug')?.trim().toLowerCase();
  if (!slug) {
    console.error('Pakai: npm run tenant:disable -- --slug demo   atau   npm run tenant:enable -- --slug demo');
    process.exit(1);
  }
  const t = await prisma.tenant.findUnique({ where: { slug } });
  if (!t) throw new Error(`Perusahaan "${slug}" tidak ditemukan`);

  if (mode === 'disable') {
    await prisma.tenant.update({ where: { id: t.id }, data: { status: 'SUSPENDED' } });
    const u = await prisma.user.updateMany({ where: { tenantId: t.id, isActive: true }, data: { isActive: false } });
    const users = await prisma.user.findMany({ where: { tenantId: t.id }, select: { id: true } });
    const r = await prisma.refreshToken.updateMany({ where: { userId: { in: users.map((x) => x.id) }, revokedAt: null }, data: { revokedAt: new Date() } });
    console.log(`Perusahaan "${t.name}" (${slug}) dinonaktifkan: ${u.count} user dinonaktifkan, ${r.count} sesi dicabut. Data tidak dihapus.`);
  } else {
    await prisma.tenant.update({ where: { id: t.id }, data: { status: 'ACTIVE' } });
    const u = await prisma.user.updateMany({ where: { tenantId: t.id, isActive: false }, data: { isActive: true } });
    console.log(`Perusahaan "${t.name}" (${slug}) aktif kembali: ${u.count} user diaktifkan.`);
  }
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
