/**
 * HAPUS PERMANEN satu perusahaan beserta seluruh datanya (proyek, PO, jurnal, user, file unggahan, dll).
 * Tidak bisa dibatalkan — backup database dulu bila ragu.
 *
 *   npm run tenant:delete -- --slug demo --confirm demo
 *
 * --confirm harus sama dengan slug sebagai pengaman.
 * Perusahaan yang dipakai SuperApps (SUPERAPPS_TENANT) tidak bisa dihapus lewat skrip ini.
 */
import '../src/env';
import { PrismaClient } from '@prisma/client';
import { existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { deleteTenant } from './cleanup';

const prisma = new PrismaClient();

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg('slug')?.trim().toLowerCase();
  if (!slug) {
    console.error('Pakai: npm run tenant:delete -- --slug demo --confirm demo');
    process.exit(1);
  }
  if (arg('confirm')?.trim().toLowerCase() !== slug) {
    console.error(`Tambahkan --confirm ${slug} untuk memastikan Anda memang ingin menghapus perusahaan "${slug}" secara permanen.`);
    process.exit(1);
  }
  const protectedSlug = (process.env.SUPERAPPS_TENANT || process.env.DEFAULT_TENANT || '').trim().toLowerCase();
  if (protectedSlug && protectedSlug === slug) throw new Error(`"${slug}" adalah perusahaan utama (SUPERAPPS_TENANT/DEFAULT_TENANT) dan tidak dihapus.`);

  const t = await prisma.tenant.findUnique({ where: { slug } });
  if (!t) throw new Error(`Perusahaan "${slug}" tidak ditemukan (mungkin sudah dihapus).`);
  const [projects, users, files] = await Promise.all([
    prisma.project.count({ where: { tenantId: t.id } }),
    prisma.user.count({ where: { tenantId: t.id } }),
    prisma.fileObject.count({ where: { tenantId: t.id } }),
  ]);

  await deleteTenant(prisma, t.id);

  // File unggahan perusahaan ini (UPLOAD_DIR/<tenantId>/)
  const dir = join(resolve(process.env.UPLOAD_DIR ?? './uploads'), t.id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  console.log(`Perusahaan "${t.name}" (${slug}) dihapus permanen: ${projects} proyek, ${users} user, ${files} file beserta seluruh transaksinya.`);
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
