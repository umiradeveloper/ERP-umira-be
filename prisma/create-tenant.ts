/**
 * Buat perusahaan (tenant) kosong untuk produksi: role standar, bagan akun, workflow approval,
 * dan (opsional) satu admin lokal cadangan. Tidak membuat data demo.
 *
 *   npm run tenant:create -- --slug umira --name "PT Umira Sinergi Global" \
 *       --admin-email admin@umira.co.id --admin-password "PasswordKuat123!"
 *
 * Bila perusahaan sudah ada, skrip hanya menambahkan role standar yang belum ada.
 */
import '../src/env';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { applyTenantTemplate, ROLES } from './tenant-template';

const prisma = new PrismaClient();

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg('slug')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  if (!slug || !/^[a-z0-9-]{2,40}$/.test(slug) || !name) {
    console.error('Pakai: npm run tenant:create -- --slug umira --name "PT Umira Sinergi Global" [--admin-email x --admin-password y --admin-name z]');
    process.exit(1);
  }
  let tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (tenant) {
    const have = new Set((await prisma.role.findMany({ where: { tenantId: tenant.id } })).map((r) => r.name));
    let added = 0;
    for (const [rn, r] of Object.entries(ROLES)) {
      if (have.has(rn)) continue;
      await prisma.role.create({ data: { tenantId: tenant.id, name: rn, description: r.desc, permissions: r.perms } });
      added++;
    }
    console.log(`Perusahaan "${slug}" sudah ada. ${added} role standar ditambahkan.`);
  } else {
    tenant = await prisma.tenant.create({
      data: { name, slug, planCode: 'BUSINESS', companies: { create: { name, code: (arg('company-code') ?? slug.slice(0, 6)).toUpperCase() } } },
    });
    await applyTenantTemplate(prisma, tenant.id);
    console.log(`Perusahaan "${name}" (${slug}) dibuat dengan ${Object.keys(ROLES).length} role, bagan akun dan workflow approval.`);
  }

  const email = arg('admin-email')?.trim().toLowerCase();
  const password = arg('admin-password');
  if (email && password) {
    if (password.length < 8) throw new Error('Password admin minimal 8 karakter');
    const admin = await prisma.role.findFirstOrThrow({ where: { tenantId: tenant.id, name: 'Administrator' } });
    const exists = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } } });
    if (exists) console.log(`Admin ${email} sudah ada — tidak diubah.`);
    else {
      await prisma.user.create({
        data: {
          tenantId: tenant.id, email, name: arg('admin-name') ?? 'Administrator', title: 'Administrator',
          passwordHash: await bcrypt.hash(password, 10), memberships: { create: { tenantId: tenant.id, roleId: admin.id } },
        },
      });
      console.log(`Admin lokal ${email} dibuat.`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
