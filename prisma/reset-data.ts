/**
 * RESET DATA: kosongkan data transaksi satu perusahaan supaya bisa mulai dari nol (mis. setelah uji coba).
 *
 *   npm run reset:data                                   → simulasi: tampilkan apa yang akan dihapus, tidak menghapus apa pun
 *   npm run reset:data -- --confirm umira                → hapus data transaksi perusahaan "umira"
 *   npm run reset:data -- --confirm umira --master       → ikut hapus customer, supplier, gudang, master barang & aset
 *   npm run reset:data -- --slug demo --confirm demo     → perusahaan lain (default: SUPERAPPS_TENANT / DEFAULT_TENANT)
 *
 * Dihapus  : tender & RAB, proyek & RAP, progres, laporan harian, VO, PR/RFQ/PO, penerimaan barang, stok,
 *            invoice, pembayaran, jurnal, approval, notifikasi, file unggahan, audit log, penomoran dokumen.
 * Tetap ada: perusahaan, user & role (termasuk user SuperApps), alur approval, bagan akun (COA), periode akuntansi.
 *
 * Tidak bisa dibatalkan — backup database dulu (mis. mysqldump) bila ragu.
 */
import '../src/env';
import { PrismaClient } from '@prisma/client';
import { existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { resetTenantData } from './cleanup';

const prisma = new PrismaClient();

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const slug = (arg('slug') ?? process.env.SUPERAPPS_TENANT ?? process.env.DEFAULT_TENANT ?? '').trim().toLowerCase();
  if (!slug) throw new Error('Perusahaan tidak diketahui. Pakai: npm run reset:data -- --slug <kode-perusahaan> --confirm <kode-perusahaan>');
  const t = await prisma.tenant.findUnique({ where: { slug } });
  if (!t) throw new Error(`Perusahaan "${slug}" tidak ditemukan.`);
  const master = flag('master');
  const w = { where: { tenantId: t.id } };

  const counts: [string, number][] = [
    ['Tender', await prisma.tender.count(w)],
    ['Proyek', await prisma.project.count(w)],
    ['Purchase request', await prisma.purchaseRequest.count(w)],
    ['Purchase order', await prisma.purchaseOrder.count(w)],
    ['Invoice pelanggan', await prisma.customerInvoice.count(w)],
    ['Invoice supplier', await prisma.supplierInvoice.count(w)],
    ['Jurnal', await prisma.journalEntry.count(w)],
    ['Mutasi stok', await prisma.stockMovement.count(w)],
    ['File unggahan', await prisma.fileObject.count(w)],
    ...(master
      ? ([
          ['Customer', await prisma.customer.count(w)],
          ['Supplier', await prisma.supplier.count(w)],
          ['Gudang', await prisma.warehouse.count(w)],
          ['Master barang', await prisma.inventoryItem.count(w)],
          ['Aset', await prisma.asset.count(w)],
        ] as [string, number][])
      : []),
  ];
  const users = await prisma.user.count(w);

  console.log(`\nPerusahaan: ${t.name} (${slug})${master ? ' — termasuk data master' : ''}`);
  console.log('Akan dihapus:');
  for (const [k, v] of counts) console.log(`  - ${k.padEnd(20)} ${v}`);
  console.log(`Tetap ada: ${users} user, role, alur approval, bagan akun${master ? '' : ', customer, supplier, gudang, master barang, aset'}.\n`);

  if (arg('confirm')?.trim().toLowerCase() !== slug) {
    console.log(`Ini hanya simulasi, belum ada yang dihapus.\nUntuk benar-benar menghapus: npm run reset:data -- ${arg('slug') ? `--slug ${slug} ` : ''}--confirm ${slug}${master ? ' --master' : ''}`);
    return;
  }

  const done = await resetTenantData(prisma, t.id, { master });
  const dir = join(resolve(process.env.UPLOAD_DIR ?? './uploads'), t.id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const total = Object.values(done).reduce((a, b) => a + b, 0);
  console.log(`Selesai. ${total} baris dihapus dari ${Object.keys(done).length} tabel; folder file unggahan perusahaan dikosongkan.`);
  console.log('Penomoran dokumen (TND-, PRJ-, PR-, PO-, …) mulai lagi dari 0001.');
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
