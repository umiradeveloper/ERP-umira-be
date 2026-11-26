/**
 * E2E test API terhadap database MySQL sungguhan (PRD §18–19).
 * Membuat dua tenant uji sendiri dan menghapusnya di akhir — data demo tidak disentuh.
 *
 *   cd backend && npm run test:e2e
 */
import '../src/env';
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureBodyLimit } from '../src/common/body-limit';
import { AppModule } from '../src/app.module';
import { deleteTenant } from '../prisma/cleanup';
import { createServer, type Server } from 'node:http';
import { SuperAppsService } from '../src/modules/superapps.module';

process.env.DISABLE_ALERT_SCAN = 'true';
process.env.LOGIN_RATE_LIMIT = '1000';
const prisma = new PrismaClient();
const PASS = 'Rahasia123!';
const run = Date.now().toString(36);

const ROLES: Record<string, string[]> = {
  Administrator: ['*'],
  'Project Manager': ['project:write', 'procurement:read', 'cost:read'],
  'Site Engineer': ['project:write', 'procurement:read'],
  Procurement: ['procurement:write', 'master:write', 'project:read', 'warehouse:write'],
  Finance: ['finance:write', 'accounting:read', 'project:read', 'procurement:read'],
  Direktur: ['project:read', 'procurement:read', 'finance:read'],
};
const COA: [string, string, any][] = [
  ['1101', 'Kas', 'ASSET'], ['1201', 'Piutang', 'ASSET'], ['1202', 'Piutang Retensi', 'ASSET'], ['1301', 'PPN Masukan', 'ASSET'],
  ['2101', 'Hutang', 'LIABILITY'], ['2201', 'PPN Keluaran', 'LIABILITY'], ['3101', 'Modal', 'EQUITY'], ['4101', 'Pendapatan', 'REVENUE'],
  ['5101', 'Material', 'EXPENSE'], ['5102', 'Upah', 'EXPENSE'], ['5103', 'Alat', 'EXPENSE'], ['5104', 'Subkon', 'EXPENSE'], ['5105', 'Overhead', 'EXPENSE'], ['5199', 'Lain', 'EXPENSE'],
];

async function createTenant(slug: string) {
  const t = await prisma.tenant.create({ data: { name: `Tenant uji ${slug}`, slug, companies: { create: { name: `PT ${slug}`, code: 'CO' } } } });
  const roleIds: Record<string, string> = {};
  for (const [name, perms] of Object.entries(ROLES)) roleIds[name] = (await prisma.role.create({ data: { tenantId: t.id, name, permissions: perms } })).id;
  const hash = await bcrypt.hash(PASS, 4);
  const users: Record<string, string> = { admin: 'Administrator', pm: 'Project Manager', site: 'Site Engineer', proc: 'Procurement', fin: 'Finance', dir: 'Direktur' };
  for (const [key, role] of Object.entries(users)) {
    await prisma.user.create({ data: { tenantId: t.id, email: `${key}@${slug}.test`, name: `${key} ${slug}`, passwordHash: hash, memberships: { create: { tenantId: t.id, roleId: roleIds[role] } } } });
  }
  await prisma.account.createMany({ data: COA.map(([code, name, accountType]) => ({ tenantId: t.id, code, name, accountType })) });
  await prisma.workflowDefinition.createMany({
    data: [
      { tenantId: t.id, entityType: 'PR', name: 'PR', version: 1, steps: [{ step: 1, roleName: 'Project Manager', minAmount: '0' }, { step: 2, roleName: 'Direktur', minAmount: '250000000' }] },
      { tenantId: t.id, entityType: 'PO', name: 'PO', version: 1, steps: [{ step: 1, roleName: 'Project Manager', minAmount: '0' }] },
    ],
  });
  return t;
}

describe('Contractor ERP API (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const A = `e2e-a-${run}`;
  const B = `e2e-b-${run}`;
  const tok: Record<string, string> = {};
  const tenantIds: string[] = [];
  let projectA = '';
  let fileA = '';

  const as = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  const login = async (slug: string, key: string) => {
    const r = await request(http).post('/api/v1/auth/login').send({ tenant: slug, email: `${key}@${slug}.test`, password: PASS }).expect(201);
    return r.body.data.accessToken as string;
  };

  beforeAll(async () => {
    tenantIds.push((await createTenant(A)).id, (await createTenant(B)).id);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    process.env.BODY_LIMIT = '1mb';
    configureBodyLimit(app as NestExpressApplication);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();
    for (const k of ['admin', 'pm', 'site', 'proc', 'fin', 'dir']) tok[k] = await login(A, k);
    tok.bAdmin = await login(B, 'admin');
  });

  afterAll(async () => {
    await app?.close();
    for (const id of tenantIds) await deleteTenant(prisma, id).catch(() => undefined);
    await prisma.$disconnect();
  });

  describe('Autentikasi', () => {
    it('menolak password salah dengan pesan generik', async () => {
      const r = await request(http).post('/api/v1/auth/login').send({ tenant: A, email: `admin@${A}.test`, password: 'salah-sekali' }).expect(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(r.body.error.requestId).toBeTruthy();
    });
    it('menolak request tanpa token', async () => {
      await request(http).get('/api/v1/projects').expect(401);
    });
    it('refresh token berotasi dan token lama tidak bisa dipakai ulang', async () => {
      const l = await request(http).post('/api/v1/auth/login').send({ tenant: A, email: `fin@${A}.test`, password: PASS }).expect(201);
      const rt = l.body.data.refreshToken;
      await request(http).post('/api/v1/auth/refresh').send({ refreshToken: rt }).expect(201);
      await request(http).post('/api/v1/auth/refresh').send({ refreshToken: rt }).expect(401);
    });
  });

  describe('Isolasi tenant', () => {
    beforeAll(async () => {
      const p = await request(http).post('/api/v1/projects').set(as('admin')).send({ name: 'Proyek rahasia A', contractValue: '1000000000' }).expect(201);
      projectA = p.body.data.id;
      await request(http).patch(`/api/v1/projects/${projectA}`).set(as('admin')).send({ status: 'ACTIVE' }).expect(200);
      const f = await request(http).post('/api/v1/files').set(as('admin')).field('entityType', 'Project').field('entityId', projectA).attach('files', Buffer.from('%PDF-1.4 rahasia'), { filename: 'kontrak.pdf', contentType: 'application/pdf' }).expect(201);
      fileA = f.body.data[0].id;
    });

    it('tenant B tidak melihat proyek tenant A di daftar', async () => {
      const r = await request(http).get('/api/v1/projects').set(as('bAdmin')).expect(200);
      expect(r.body.data.find((p: any) => p.id === projectA)).toBeUndefined();
    });
    it('tenant B mendapat 404 saat membuka/mengubah proyek tenant A (IDOR)', async () => {
      await request(http).get(`/api/v1/projects/${projectA}`).set(as('bAdmin')).expect(404);
      await request(http).patch(`/api/v1/projects/${projectA}`).set(as('bAdmin')).send({ status: 'ON_HOLD' }).expect(404);
    });
    it('tenant B tidak bisa mengunduh file atau melihat lampiran tenant A', async () => {
      await request(http).get(`/api/v1/files/${fileA}/download`).set(as('bAdmin')).expect(404);
      await request(http).get(`/api/v1/files?entityType=Project&entityId=${projectA}`).set(as('bAdmin')).expect(404);
    });
    it('tenant B tidak bisa mengekspor BQ proyek tenant A', async () => {
      await request(http).get(`/api/v1/exports/bq.xlsx?projectId=${projectA}`).set(as('bAdmin')).expect(404);
    });
    it('tenantId dari body request ditolak (mass assignment)', async () => {
      const r = await request(http).post('/api/v1/customers').set(as('bAdmin')).send({ code: 'X1', name: 'Coba', tenantId: tenantIds[0] }).expect(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('RBAC', () => {
    it('Site Engineer tidak bisa membaca jurnal atau mengekspor neraca saldo', async () => {
      await request(http).get('/api/v1/journals').set(as('site')).expect(403);
      await request(http).get('/api/v1/exports/trial-balance.xlsx').set(as('site')).expect(403);
    });
    it('Finance tidak bisa membuat user', async () => {
      await request(http).post('/api/v1/users').set(as('fin')).send({ email: 'x@y.z', name: 'X', password: '12345678', roleIds: ['x'] }).expect(403);
    });
  });

  describe('Procure-to-pay & approval', () => {
    let supplierId = '';
    let prId = '';
    let poId = '';
    let invId = '';

    beforeAll(async () => {
      const s = await request(http).post('/api/v1/suppliers').set(as('proc')).send({ code: 'SUP1', name: 'Supplier Uji', paymentTerm: 30 }).expect(201);
      supplierId = s.body.data.id;
    });

    it('pengaju tidak dapat menyetujui PR miliknya sendiri', async () => {
      const pr = await request(http).post('/api/v1/purchase-requests').set(as('pm')).send({ projectId: projectA, items: [{ description: 'Semen', quantity: '10', estimatedPrice: '70000', category: 'MATERIAL' }] }).expect(201);
      await request(http).post(`/api/v1/purchase-requests/${pr.body.data.id}/submit`).set(as('pm')).expect(201);
      const inbox = await request(http).get('/api/v1/approvals/inbox').set(as('pm')).expect(200);
      const req = inbox.body.data.find((x: any) => x.entityId === pr.body.data.id);
      expect(req.canAct).toBe(false);
      const r = await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('pm')).send({ decision: 'APPROVE' }).expect(403);
      expect(r.body.error.code).toBe('SELF_APPROVAL');
    });

    it('role yang salah tidak dapat memutuskan langkah approval', async () => {
      const pr = await request(http).post('/api/v1/purchase-requests').set(as('site')).send({ projectId: projectA, items: [{ description: 'Pasir', quantity: '5', estimatedPrice: '300000', category: 'MATERIAL' }] }).expect(201);
      prId = pr.body.data.id;
      await request(http).post(`/api/v1/purchase-requests/${prId}/submit`).set(as('site')).expect(201);
      const inbox = await request(http).get('/api/v1/approvals/inbox').set(as('fin')).expect(200);
      const req = inbox.body.data.find((x: any) => x.entityId === prId);
      const r = await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('fin')).send({ decision: 'APPROVE' }).expect(403);
      expect(r.body.error.code).toBe('NOT_APPROVER');
    });

    it('menolak tanpa komentar tidak diperbolehkan; PM menyetujui → PR APPROVED + notifikasi ke pengaju', async () => {
      const inbox = await request(http).get('/api/v1/approvals/inbox').set(as('pm')).expect(200);
      const req = inbox.body.data.find((x: any) => x.entityId === prId);
      await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('pm')).send({ decision: 'REJECT' }).expect(422);
      const r = await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('pm')).send({ decision: 'APPROVE', comment: 'OK' }).expect(201);
      expect(r.body.data.status).toBe('APPROVED');
      const pr = await request(http).get(`/api/v1/purchase-requests/${prId}`).set(as('site')).expect(200);
      expect(pr.body.data.status).toBe('APPROVED');
      const n = await request(http).get('/api/v1/notifications').set(as('site')).expect(200);
      expect(n.body.data.items.some((x: any) => x.type === 'APPROVAL_RESULT')).toBe(true);
    });

    it('PR → PO → approval → terbit → GRN parsial', async () => {
      const po = await request(http).post('/api/v1/purchase-orders').set(as('proc')).send({
        projectId: projectA, supplierId, requestId: prId, taxPct: '11', items: [{ description: 'Pasir', quantity: '5', unitPrice: '280000', category: 'MATERIAL' }],
      }).expect(201);
      poId = po.body.data.id;
      expect(po.body.data.total).toBe('1554000'); // 1.400.000 + PPN 11%
      await request(http).post(`/api/v1/purchase-orders/${poId}/submit`).set(as('proc')).expect(201);
      const inbox = await request(http).get('/api/v1/approvals/inbox').set(as('pm')).expect(200);
      const req = inbox.body.data.find((x: any) => x.entityId === poId);
      await request(http).post(`/api/v1/approvals/${req.id}/decision`).set(as('pm')).send({ decision: 'APPROVE' }).expect(201);
      await request(http).post(`/api/v1/purchase-orders/${poId}/issue`).set(as('proc')).expect(201);

      const full = await request(http).get(`/api/v1/purchase-orders/${poId}`).set(as('proc')).expect(200);
      const itemId = full.body.data.items[0].id;
      await request(http).post('/api/v1/goods-receipts').set(as('proc')).send({ poId, receiptDate: new Date().toISOString(), lines: [{ poItemId: itemId, quantity: '6' }] }).expect(422);
      await request(http).post('/api/v1/goods-receipts').set(as('proc')).send({ poId, receiptDate: new Date().toISOString(), lines: [{ poItemId: itemId, quantity: '3' }] }).expect(201);
      const after = await request(http).get(`/api/v1/purchase-orders/${poId}`).set(as('proc')).expect(200);
      expect(after.body.data.status).toBe('PARTIAL_RECEIPT');
    });

    it('3-way match: tagihan berlebih ditandai MISMATCH dan tidak bisa diposting', async () => {
      const inv = await request(http).post('/api/v1/supplier-invoices').set(as('fin')).send({ poId, supplierRef: 'INV-BAD', invoiceDate: new Date().toISOString(), subtotal: '900000' }).expect(201);
      expect(inv.body.data.status).toBe('MISMATCH');
      await request(http).post(`/api/v1/supplier-invoices/${inv.body.data.id}/post`).set(as('fin')).expect(422);
    });

    it('invoice duplikat dari supplier ditolak', async () => {
      const r = await request(http).post('/api/v1/supplier-invoices').set(as('fin')).send({ poId, supplierRef: 'INV-BAD', invoiceDate: new Date().toISOString(), subtotal: '840000' }).expect(422);
      expect(r.body.error.code).toBe('DUPLICATE_INVOICE');
    });

    it('posting invoice memindahkan commitment ke actual tanpa double count, idempotent', async () => {
      const before = (await request(http).get(`/api/v1/projects/${projectA}`).set(as('admin')).expect(200)).body.data.cost.total;
      const inv = await request(http).post('/api/v1/supplier-invoices').set(as('fin')).send({ poId, supplierRef: 'INV-OK', invoiceDate: new Date().toISOString(), subtotal: '840000' }).expect(201);
      invId = inv.body.data.id;
      expect(inv.body.data.status).toBe('MATCHED');
      await request(http).post(`/api/v1/supplier-invoices/${invId}/post`).set(as('fin')).expect(201);
      await request(http).post(`/api/v1/supplier-invoices/${invId}/post`).set(as('fin')).expect(201); // kedua kali: tidak ada efek
      const after = (await request(http).get(`/api/v1/projects/${projectA}`).set(as('admin')).expect(200)).body.data.cost.total;
      expect(Number(after.actual) - Number(before.actual)).toBe(840000);
      expect(Number(before.commitment) - Number(after.commitment)).toBe(840000);
      expect(Number(after.actual) + Number(after.commitment)).toBe(Number(before.actual) + Number(before.commitment));
      const journals = await prisma.journalEntry.count({ where: { tenantId: tenantIds[0], postingRef: `SINV:${invId}` } });
      expect(journals).toBe(1);
    });

    it('pembayaran melebihi sisa ditolak; pembayaran penuh → PAID; neraca saldo balance', async () => {
      await request(http).post(`/api/v1/supplier-invoices/${invId}/pay`).set(as('fin')).send({ paymentDate: new Date().toISOString(), amount: '99999999' }).expect(422);
      const r = await request(http).post(`/api/v1/supplier-invoices/${invId}/pay`).set(as('fin')).send({ paymentDate: new Date().toISOString(), amount: '932400' }).expect(201);
      expect(r.body.data.status).toBe('PAID');
      const tb = await request(http).get('/api/v1/reports/trial-balance').set(as('admin')).expect(200);
      expect(tb.body.data.balanced).toBe(true);
    });
  });

  describe('Jurnal & periode', () => {
    let kas = '';
    let modal = '';
    beforeAll(async () => {
      const acc = (await request(http).get('/api/v1/accounts').set(as('admin')).expect(200)).body.data;
      kas = acc.find((a: any) => a.code === '1101').id;
      modal = acc.find((a: any) => a.code === '3101').id;
    });

    it('jurnal tidak balance ditolak 422', async () => {
      const r = await request(http).post('/api/v1/journals').set(as('admin')).send({ entryDate: '2026-01-10', lines: [{ accountId: kas, debit: '100', credit: '0' }, { accountId: modal, debit: '0', credit: '90' }] }).expect(422);
      expect(r.body.error.code).toBe('UNBALANCED');
    });

    it('jurnal posted tidak bisa dihapus; koreksi lewat reversal', async () => {
      const j = await request(http).post('/api/v1/journals').set(as('admin')).send({ entryDate: new Date().toISOString(), lines: [{ accountId: kas, debit: '500000', credit: '0' }, { accountId: modal, debit: '0', credit: '500000' }] }).expect(201);
      await request(http).post(`/api/v1/journals/${j.body.data.id}/post`).set(as('admin')).expect(201);
      await request(http).delete(`/api/v1/journals/${j.body.data.id}`).set(as('admin')).expect(422);
      const rev = await request(http).post(`/api/v1/journals/${j.body.data.id}/reverse`).set(as('admin')).expect(201);
      expect(rev.body.data.status).toBe('POSTED');
      const orig = await request(http).get(`/api/v1/journals/${j.body.data.id}`).set(as('admin')).expect(200);
      expect(orig.body.data.status).toBe('REVERSED');
    });

    it('periode yang ditutup menolak posting', async () => {
      const j = await request(http).post('/api/v1/journals').set(as('admin')).send({ entryDate: '2025-03-15', lines: [{ accountId: kas, debit: '1000', credit: '0' }, { accountId: modal, debit: '0', credit: '1000' }] }).expect(201);
      await request(http).post(`/api/v1/accounting-periods/2025-03/close`).set(as('admin')).expect(422); // masih ada draft
      await request(http).delete(`/api/v1/journals/${j.body.data.id}`).set(as('admin')).expect(200);
      await request(http).post(`/api/v1/accounting-periods/2025-03/close`).set(as('admin')).expect(201);
      const j2 = await request(http).post('/api/v1/journals').set(as('admin')).send({ entryDate: '2025-03-20', lines: [{ accountId: kas, debit: '1000', credit: '0' }, { accountId: modal, debit: '0', credit: '1000' }] }).expect(201);
      const r = await request(http).post(`/api/v1/journals/${j2.body.data.id}/post`).set(as('admin')).expect(422);
      expect(r.body.error.code).toBe('PERIOD_CLOSED');
    });
  });

  describe('Gudang & stok', () => {
    it('stok tidak boleh minus; moving average dihitung saat barang masuk', async () => {
      const wh = await request(http).post('/api/v1/warehouses').set(as('admin')).send({ code: 'WH1', name: 'Gudang uji' }).expect(201);
      const it = await request(http).post('/api/v1/inventory/items').set(as('admin')).send({ code: 'ITM1', name: 'Besi uji', unit: 'kg', category: 'MATERIAL', minStock: '5' }).expect(201);
      await request(http).post('/api/v1/stock-movements').set(as('admin')).send({ type: 'ISSUE', warehouseId: wh.body.data.id, lines: [{ itemId: it.body.data.id, quantity: '1' }] }).expect(422);
      // opname menjadikan stok 10 lalu pakai 7 → sisa 3 (di bawah minimum)
      await request(http).post('/api/v1/stock-movements').set(as('admin')).send({ type: 'OPNAME', warehouseId: wh.body.data.id, lines: [{ itemId: it.body.data.id, quantity: '10' }] }).expect(201);
      await request(http).post('/api/v1/stock-movements').set(as('admin')).send({ type: 'ISSUE', warehouseId: wh.body.data.id, lines: [{ itemId: it.body.data.id, quantity: '7' }] }).expect(201);
      const st = await request(http).get(`/api/v1/inventory/stock?warehouseId=${wh.body.data.id}`).set(as('admin')).expect(200);
      expect(st.body.data[0].quantity).toBe('3');
      expect(st.body.data[0].low).toBe(true);
    });
  });

  describe('Export', () => {
    it('Excel dan PDF bisa diunduh sesuai hak akses', async () => {
      const x = await request(http).get('/api/v1/exports/projects.xlsx').set(as('admin')).buffer(true).expect(200);
      expect(x.headers['content-type']).toContain('spreadsheetml');
      const po = await prisma.purchaseOrder.findFirst({ where: { tenantId: tenantIds[0] } });
      const pdf = await request(http).get(`/api/v1/documents/purchase-orders/${po!.id}.pdf`).set(as('proc')).buffer(true).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      await request(http).get(`/api/v1/documents/purchase-orders/${po!.id}.pdf`).set(as('bAdmin')).expect(404);
    });
  });

  describe('Sinkron vendor dari endpoint (Basic Auth)', () => {
    let srv: Server;
    let hits = 0;
    const env = { ...process.env };
    beforeAll(async () => {
      srv = createServer((req, res) => {
        hits++;
        if (req.headers.authorization !== 'Basic ' + Buffer.from('umira:rahasia').toString('base64')) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [
          { vendor_code: 'v 001', vendor_name: 'PT Baja Umira', npwp: '01.234', no_telp: '0812', email: 'baja@umira.test', top: '45 hari' },
          { vendor_code: 'V-002', vendor_name: 'CV Semen Jaya' },
          { vendor_code: '', vendor_name: 'Tanpa kode' },
        ] }));
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      const port = (srv.address() as any).port;
      Object.assign(process.env, {
        VENDOR_SOURCE_URL: `http://127.0.0.1:${port}/vendors`, VENDOR_SOURCE_USER: 'umira', VENDOR_SOURCE_PASSWORD: 'rahasia',
        VENDOR_FIELD_MAP: JSON.stringify({ code: 'vendor_code', name: 'vendor_name', phone: 'no_telp', paymentTerm: 'top' }),
      });
    });
    afterAll(async () => {
      process.env = env;
      await new Promise((r) => srv.close(r));
    });

    it('membuat dan memperbarui vendor berdasarkan kode, melewati data tanpa kode', async () => {
      const st = await request(http).get('/api/v1/suppliers/sync').set(as('proc')).expect(200);
      expect(st.body.data.configured).toBe(true);
      const r1 = await request(http).post('/api/v1/suppliers/sync').set(as('proc')).expect(201);
      expect(r1.body.data).toMatchObject({ fetched: 3, created: 2, updated: 0 });
      expect(r1.body.data.skipped).toHaveLength(1);
      const s = await prisma.supplier.findFirst({ where: { tenantId: tenantIds[0], code: 'V-001' } });
      expect(s).toMatchObject({ name: 'PT Baja Umira', taxNumber: '01.234', phone: '0812', paymentTerm: 45 });
      const r2 = await request(http).post('/api/v1/suppliers/sync').set(as('proc')).expect(201);
      expect(r2.body.data).toMatchObject({ created: 0, unchanged: 2 });
      // tenant lain tidak ikut tersinkron
      expect(await prisma.supplier.count({ where: { tenantId: tenantIds[1], code: 'V-001' } })).toBe(0);
    });
    it('password salah menghasilkan pesan yang jelas', async () => {
      process.env.VENDOR_SOURCE_PASSWORD = 'salah';
      const r = await request(http).post('/api/v1/suppliers/sync').set(as('proc')).expect(422);
      expect(r.body.error.code).toBe('VENDOR_SOURCE_AUTH');
      process.env.VENDOR_SOURCE_PASSWORD = 'rahasia';
    });
    it('VENDOR_MANUAL_INPUT=false menolak tambah vendor manual', async () => {
      process.env.VENDOR_MANUAL_INPUT = 'false';
      const r = await request(http).post('/api/v1/suppliers').set(as('proc')).send({ code: 'MANUAL1', name: 'Manual' }).expect(422);
      expect(r.body.error.code).toBe('VENDOR_MANAGED_EXTERNALLY');
      delete process.env.VENDOR_MANUAL_INPUT;
      expect(hits).toBeGreaterThan(0);
    });
    it('Direktur (tanpa hak tulis) tidak bisa menjalankan sinkron', async () => {
      await request(http).post('/api/v1/suppliers/sync').set(as('dir')).expect(403);
    });
  });

  describe('Login dengan akun SuperApps', () => {
    const env = { ...process.env };
    const SA_DB = 'superapps_test';
    let mysql: any;
    let conn: any;
    const saHash = bcrypt.hashSync('RahasiaSA1', 4);
    beforeAll(async () => {
      mysql = await import('mysql2/promise');
      const base = new URL(process.env.DATABASE_URL!);
      conn = await mysql.createConnection({ host: base.hostname, port: Number(base.port || 3306), user: decodeURIComponent(base.username), password: decodeURIComponent(base.password), multipleStatements: true });
      await conn.query(`CREATE DATABASE IF NOT EXISTS ${SA_DB}; USE ${SA_DB};
        DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS role;
        CREATE TABLE role (id_role varchar(100) PRIMARY KEY, nama_role varchar(100), kode_role varchar(100));
        CREATE TABLE users (id_user varchar(100) PRIMARY KEY, id_branch varchar(100), id_role varchar(100), nama varchar(100), nip varchar(100), username varchar(100), password text, email varchar(100), no_hp varchar(100), isApproval int DEFAULT 0);`);
      await conn.query('INSERT INTO role VALUES (?,?,?),(?,?,?),(?,?,?)', ['r-proc', 'Staff Procurement', '02', 'r-vendor', 'Vendor', '01', 'r-pm', 'Project manager', '06']);
      await conn.query('INSERT INTO users (id_user,id_role,nama,username,password,email,isApproval) VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?),(?,?,?,?,?,?,?),(?,?,?,?,?,?,?)', [
        'sa-1', 'r-proc', 'PT Umira Sinergi Global', 'Slamet Uji', saHash, ' Slamet.Uji@Umira.test ', 1,
        'sa-2', 'r-vendor', 'PT Vendor Uji', null, saHash, 'vendor@uji.test', 1,
        'sa-3', 'r-proc', 'PT Umira Sinergi Global', 'Belum Approve', saHash, 'pending@umira.test', 0,
        'sa-4', 'r-pm', 'PT Umira Sinergi Global', 'Dewi PM', saHash, 'dewi@umira.test', 1,
      ]);
      const base2 = new URL(process.env.DATABASE_URL!);
      base2.pathname = `/${SA_DB}`;
      Object.assign(process.env, { SUPERAPPS_DATABASE_URL: base2.toString(), SUPERAPPS_TENANT: A });
      app.get(SuperAppsService).setRoleMap({ 'Staff Procurement': ['Procurement'], 'Project manager': ['Project Manager'], Vendor: [] });
    });
    afterAll(async () => {
      process.env = env;
      await conn?.query(`DROP DATABASE IF EXISTS ${SA_DB}`);
      await conn?.end();
    });
    const loginSa = (email: string, password = 'RahasiaSA1') => request(http).post('/api/v1/auth/login').send({ email, password });

    it('config login menunjukkan perusahaan tetap & SuperApps aktif', async () => {
      const r = await request(http).get('/api/v1/auth/config').expect(200);
      expect(r.body.data).toEqual({ tenant: A, superapps: true, demo: false });
    });
    it('login dengan email SuperApps (tanpa kode perusahaan) membuat user ERP dengan role terpetakan', async () => {
      const r = await loginSa('slamet.uji@umira.test').expect(201);
      expect(r.body.data.user).toMatchObject({ name: 'Slamet Uji', roles: ['Procurement'], tenant: { slug: A } });
      const u = await prisma.user.findFirst({ where: { tenantId: tenantIds[0], externalId: 'sa-1' } });
      expect(u).toMatchObject({ externalSource: 'superapps', passwordHash: null, email: 'slamet.uji@umira.test' });
    });
    it('login dengan username juga bisa', async () => {
      await loginSa('Slamet Uji').expect(201);
      expect(await prisma.user.count({ where: { tenantId: tenantIds[0], externalId: 'sa-1' } })).toBe(1);
    });
    it('password salah, belum disetujui, dan role Vendor ditolak', async () => {
      expect((await loginSa('slamet.uji@umira.test', 'salah-salah').expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
      expect((await loginSa('pending@umira.test').expect(401)).body.error.code).toBe('SUPERAPPS_NOT_APPROVED');
      expect((await loginSa('vendor@uji.test').expect(401)).body.error.code).toBe('SUPERAPPS_ROLE_DENIED');
    });
    it('akun lokal ERP tetap bisa login bila tidak ada di SuperApps', async () => {
      await request(http).post('/api/v1/auth/login').send({ tenant: A, email: `fin@${A}.test`, password: PASS }).expect(201);
    });
    it('perubahan role di SuperApps ikut terbawa saat login berikutnya', async () => {
      await conn.query(`UPDATE ${SA_DB}.users SET id_role='r-pm' WHERE id_user='sa-1'`);
      const r = await loginSa('slamet.uji@umira.test').expect(201);
      expect(r.body.data.user.roles).toEqual(['Project Manager']);
    });
    it('role user SuperApps tidak bisa diubah dari ERP', async () => {
      const u = await prisma.user.findFirstOrThrow({ where: { tenantId: tenantIds[0], externalId: 'sa-1' } });
      const role = await prisma.role.findFirstOrThrow({ where: { tenantId: tenantIds[0], name: 'Finance' } });
      const r = await request(http).patch(`/api/v1/users/${u.id}`).set(as('admin')).send({ roleIds: [role.id] }).expect(422);
      expect(r.body.error.code).toBe('EXTERNAL_USER_ROLES');
    });
    it('sinkron membuat user yang berhak dan menonaktifkan user yang dicabut aksesnya', async () => {
      const login = await loginSa('dewi@umira.test').expect(201);
      const s1 = await request(http).post('/api/v1/superapps/sync-users').set(as('admin')).expect(201);
      expect(s1.body.data).toMatchObject({ total: 4, deactivated: 0 });
      await conn.query(`UPDATE ${SA_DB}.users SET isApproval=2 WHERE id_user='sa-4'`);
      const s2 = await request(http).post('/api/v1/superapps/sync-users').set(as('admin')).expect(201);
      expect(s2.body.data.deactivated).toBe(1);
      expect((await prisma.user.findFirstOrThrow({ where: { tenantId: tenantIds[0], externalId: 'sa-4' } })).isActive).toBe(false);
      await request(http).post('/api/v1/auth/refresh').send({ refreshToken: login.body.data.refreshToken }).expect(401);
      // tenant lain tidak bisa menjalankan sinkron SuperApps
      await request(http).post('/api/v1/superapps/sync-users').set(as('bAdmin')).expect(422);
    });
    it('pemetaan role SuperApps bisa diatur dari halaman admin dan role kustom membatasi menu', async () => {
      const g = (await request(http).get('/api/v1/superapps/role-map').set(as('admin')).expect(200)).body.data;
      expect(g).toMatchObject({ enabled: true, source: 'file' });
      expect(g.roles.find((r: any) => r.name === 'Staff Procurement')).toMatchObject({ users: 1, erpRoles: ['Procurement'] });
      expect(g.roles.find((r: any) => r.name === 'Vendor').erpRoles).toEqual([]);

      // role kustom: hanya lihat proyek, menu Proyek saja
      const role = (await request(http).post('/api/v1/roles').set(as('admin')).send({ name: 'Vendor Portal', description: 'Uji', permissions: ['project:read'], menus: ['/dashboard', '/projects'] }).expect(201)).body.data;
      await request(http).put('/api/v1/superapps/role-map').set(as('admin')).send({ map: { 'Staff Procurement': ['Procurement'], 'Project manager': ['Project Manager'], Vendor: ['Tidak Ada'] } }).expect(422);
      await request(http).put('/api/v1/superapps/role-map').set(as('pm')).send({ map: {} }).expect(403);
      await request(http).put('/api/v1/superapps/role-map').set(as('admin')).send({ map: { 'Staff Procurement': ['Procurement'], 'Project manager': ['Project Manager'], Vendor: ['Vendor Portal'] } }).expect(200);
      const v = await loginSa('vendor@uji.test').expect(201);
      expect(v.body.data.user).toMatchObject({ roles: ['Vendor Portal'], perms: ['project:read'], menus: ['/dashboard', '/projects'] });
      expect((await request(http).get('/api/v1/superapps/role-map').set(as('admin'))).body.data.source).toBe('database');

      // ganti nama role → pemetaan ikut; role yang dipakai tidak bisa dihapus
      await request(http).patch(`/api/v1/roles/${role.id}`).set(as('admin')).send({ name: 'Portal Vendor', permissions: ['project:read', 'procurement:read'], menus: null }).expect(200);
      const v2 = await loginSa('vendor@uji.test').expect(201);
      expect(v2.body.data.user).toMatchObject({ roles: ['Portal Vendor'], menus: null });
      expect(v2.body.data.user.perms.sort()).toEqual(['procurement:read', 'project:read']);
      expect((await request(http).delete(`/api/v1/roles/${role.id}`).set(as('admin')).expect(422)).body.error.code).toBe('ROLE_IN_USE');
      // kembalikan pemetaan agar tes lain tidak terpengaruh
      app.get(SuperAppsService).setRoleMap({ 'Staff Procurement': ['Procurement'], 'Project manager': ['Project Manager'], Vendor: [] });
    });
  });

  describe('BK/PU penetapan, efisiensi & foto proyek', () => {
    let pid: string;
    it('BK/PU penetapan tidak bisa diisi manual; kosong sampai RAP ditetapkan', async () => {
      await request(http).post('/api/v1/projects').set(as('admin')).send({ name: 'Proyek BKPU', contractValue: '2000000000', bkpuPenetapanPct: '88.5' }).expect(400);
      const p = await request(http).post('/api/v1/projects').set(as('admin')).send({ name: 'Proyek BKPU', contractValue: '2000000000' }).expect(201);
      pid = p.body.data.id;
      const d = await request(http).get(`/api/v1/projects/${pid}`).set(as('admin')).expect(200);
      expect(d.body.data.bkpuPenetapanPct).toBeNull();
      expect(d.body.data).toHaveProperty('efisiensiPct', null);
      await request(http).patch(`/api/v1/projects/${pid}`).set(as('admin')).send({ bkpuPenetapanPct: '90.25' }).expect(400);
    });
    it('foto proyek harus gambar milik proyek itu; terhapus otomatis saat file dihapus', async () => {
      const pdf = await request(http).post('/api/v1/files').set(as('admin')).field('entityType', 'Project').field('entityId', pid).attach('files', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' }).expect(201);
      await request(http).patch(`/api/v1/projects/${pid}`).set(as('admin')).send({ coverFileId: pdf.body.data[0].id }).expect(422);
      const img = await request(http).post('/api/v1/files').set(as('admin')).field('entityType', 'Project').field('entityId', pid).attach('files', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'foto.png', contentType: 'image/png' }).expect(201);
      await request(http).patch(`/api/v1/projects/${pid}`).set(as('admin')).send({ coverFileId: img.body.data[0].id, coverTitle: '  Tampak depan  ' }).expect(200);
      let d = (await request(http).get(`/api/v1/projects/${pid}`).set(as('admin'))).body.data;
      expect(d).toMatchObject({ coverFileId: img.body.data[0].id, coverTitle: 'Tampak depan' });
      await request(http).patch(`/api/v1/projects/${pid}`).set(as('admin')).send({ coverTitle: 'Progres struktur lantai 3' }).expect(200);
      d = (await request(http).get(`/api/v1/projects/${pid}`).set(as('admin'))).body.data;
      expect(d).toMatchObject({ coverFileId: img.body.data[0].id, coverTitle: 'Progres struktur lantai 3' });
      await request(http).delete(`/api/v1/files/${img.body.data[0].id}`).set(as('admin')).expect(200);
      expect((await request(http).get(`/api/v1/projects/${pid}`).set(as('admin'))).body.data).toMatchObject({ coverFileId: null, coverTitle: null });
      await request(http).patch(`/api/v1/projects/${pid}`).set(as('admin')).send({ coverFileId: '00000000-0000-0000-0000-000000000000' }).expect(404);
    });
  });

  describe('Presisi BQ sama dengan Excel', () => {
    it('volume & harga satuan bergelombang desimal disimpan utuh; jumlah = volume × harga (dibulatkan ke sen)', async () => {
      const t = await request(http).post('/api/v1/tenders').set(as('admin')).send({ title: 'Tender presisi' }).expect(201);
      const items = [
        { section: 'A', code: 'A.1', description: 'Beton K-300', unit: 'm3', category: 'MATERIAL', quantity: '12.345678', unitCost: '1152345.678912' },
        { section: 'A', code: 'A.2', description: 'Besi', unit: 'kg', category: 'MATERIAL', quantity: '2500.5', unitCost: '14231.4567' },
      ];
      const r = await request(http).put(`/api/v1/tenders/${t.body.data.id}/items`).set(as('admin')).send({ items }).expect(200);
      const got = r.body.data.items;
      expect(Number(got[0].quantity)).toBe(12.345678);
      expect(Number(got[0].unitCost)).toBe(1152345.678912);
      // Excel: =12.345678*1152345.678912 = 14226472.24... → 14226472.24
      expect(Number(got[0].amount)).toBe(Math.round(12.345678 * 1152345.678912 * 100) / 100);
      expect(Number(got[1].amount)).toBe(Math.round(2500.5 * 14231.4567 * 100) / 100);
    });
    it('uraian BQ yang panjang (mis. spesifikasi AHSP) bisa disimpan', async () => {
      const t = await request(http).post('/api/v1/tenders').set(as('admin')).send({ title: 'Tender uraian panjang' }).expect(201);
      const long = 'Pekerjaan beton bertulang mutu fc 25 MPa termasuk bekisting, pembesian, pengecoran, perawatan beton dan pengujian sampel silinder sesuai spesifikasi teknis. '.repeat(6);
      const r = await request(http).put(`/api/v1/tenders/${t.body.data.id}/items`).set(as('admin'))
        .send({ items: [{ section: 'III. PEKERJAAN STRUKTUR ATAS — GEDUNG UTAMA LANTAI 1 SAMPAI DENGAN LANTAI ATAP TERMASUK TANGGA DAN RAMP', code: 'III.1', description: long, unit: 'm3', category: 'MATERIAL', quantity: '1', unitCost: '1' }] })
        .expect(200);
      expect(r.body.data.items[0].description).toBe(long);
    });
  });

  describe('RAP disusun setelah menang tender dengan RAB sebagai acuan', () => {
    let projectId: string;
    it('menang tender → RAB dibuat dan draf RAP mengikuti struktur RAB (belum ditetapkan)', async () => {
      const t = await request(http).post('/api/v1/tenders').set(as('admin')).send({ title: 'Tender RAP', overheadAmount: '1000000', contingencyPct: '0' }).expect(201);
      const tid = t.body.data.id;
      await request(http).put(`/api/v1/tenders/${tid}/items`).set(as('admin')).send({ items: [
        { section: 'I. Persiapan', code: 'I.1', description: 'Mobilisasi', unit: 'ls', category: 'EQUIPMENT', quantity: '1', unitCost: '5000000' },
        { section: 'II. Struktur', code: 'II.1', description: 'Beton K-300', unit: 'm3', category: 'MATERIAL', quantity: '10.5', unitCost: '1200000.5' },
      ] }).expect(200);
      await request(http).post(`/api/v1/tenders/${tid}/submit`).set(as('admin')).expect(201);
      const d = await request(http).post(`/api/v1/tenders/${tid}/decision`).set(as('admin')).send({ decision: 'WON' }).expect(201);
      projectId = d.body.data.projectId;
      const r = (await request(http).get(`/api/v1/projects/${projectId}/rap`).set(as('admin')).expect(200)).body.data;
      expect(r.locked).toBe(false);
      expect(r.rab).toHaveLength(2);
      const linked = r.budget.items.filter((i: any) => i.bqItemId);
      expect(linked).toHaveLength(2);
      expect(linked[1]).toMatchObject({ section: 'II. Struktur', code: 'II.1', description: 'Beton K-300', bqItemId: r.rab[1].id });
      expect(Number(linked[1].unitRate)).toBe(1200000.5);
      expect(r.budget.items.find((i: any) => i.description === 'Overhead proyek')).toBeTruthy();
    });
    it('RAP bisa diubah (harga, baris tambahan) lalu ditetapkan; setelah itu terkunci', async () => {
      const r = (await request(http).get(`/api/v1/projects/${projectId}/rap`).set(as('admin'))).body.data;
      const items = r.rab.map((b: any) => ({ bqItemId: b.id, section: b.section, code: b.code, description: b.description, unit: b.unit, category: b.category, quantity: String(b.quantity), unitRate: b.code === 'II.1' ? '1100000' : '4500000' }));
      items.push({ section: 'Biaya tidak langsung', code: 'BTL.1', description: 'Gaji staf lapangan', unit: 'bln', category: 'OVERHEAD', quantity: '3', unitRate: '8000000' });
      const s = (await request(http).put(`/api/v1/projects/${projectId}/rap`).set(as('admin')).send({ items }).expect(200)).body.data;
      expect(Number(s.totals.rap)).toBe(4500000 + 10.5 * 1100000 + 24000000);
      expect(s.totals.bkpuPct).toBeGreaterThan(0);
      await request(http).put(`/api/v1/projects/${projectId}/rap`).set(as('admin')).send({ items: [{ ...items[0], bqItemId: '00000000-0000-0000-0000-000000000000' }] }).expect(422);
      const a = (await request(http).post(`/api/v1/projects/${projectId}/rap/approve`).set(as('admin')).expect(201)).body.data;
      expect(a.locked).toBe(true);
      // BK/PU penetapan otomatis = total RAP ÷ total RAB saat RAP ditetapkan
      const pd = (await request(http).get(`/api/v1/projects/${projectId}`).set(as('admin'))).body.data;
      expect(Number(pd.bkpuPenetapanPct)).toBe(s.totals.bkpuPct);
      expect(Number(pd.bkpuPenetapanPct)).toBeCloseTo((Number(s.totals.rap) / Number(s.totals.rab)) * 100, 2);
      // tidak bisa diisi manual
      await request(http).patch(`/api/v1/projects/${projectId}`).set(as('admin')).send({ bkpuPenetapanPct: '50' }).expect(400);
      const again = await request(http).put(`/api/v1/projects/${projectId}/rap`).set(as('admin')).send({ items }).expect(422);
      expect(again.body.error.code).toBe('RAP_LOCKED');
      // Cost control memakai RAP yang ditetapkan
      const cost = (await request(http).get(`/api/v1/projects/${projectId}`).set(as('admin'))).body.data.cost;
      expect(Number(cost.total.budget)).toBe(4500000 + 10.5 * 1100000 + 24000000);
    });
    it('proyek manual: RAP kosong bisa diisi tanpa acuan RAB; RAP kosong tidak bisa ditetapkan', async () => {
      const p = await request(http).post('/api/v1/projects').set(as('admin')).send({ name: 'Proyek manual RAP', contractValue: '500000000' }).expect(201);
      await request(http).post(`/api/v1/projects/${p.body.data.id}/rap/approve`).set(as('admin')).expect(422);
      await request(http).put(`/api/v1/projects/${p.body.data.id}/rap`).set(as('admin')).send({ items: [{ section: 'A', code: 'A.1', description: 'Pekerjaan tanah', unit: 'm3', category: 'LABOR', quantity: '100', unitRate: '75000' }] }).expect(200);
      await request(http).put(`/api/v1/projects/${p.body.data.id}/rap`).set(as('fin')).send({ items: [] }).expect(403);
    });
  });
  describe('Role & menu', () => {
    it('admin bisa membuat, mengubah dan menghapus role; hak akses divalidasi', async () => {
      await request(http).post('/api/v1/roles').set(as('pm')).send({ name: 'X', permissions: [] }).expect(403);
      await request(http).post('/api/v1/roles').set(as('admin')).send({ name: 'Salah', permissions: ['*'] }).expect(422);
      await request(http).post('/api/v1/roles').set(as('admin')).send({ name: 'Finance', permissions: [] }).expect(422);
      const r = (await request(http).post('/api/v1/roles').set(as('admin')).send({ name: 'Staf Gudang', permissions: ['warehouse:write', 'warehouse:read', 'project:read'], menus: ['/inventory', '/inventory'] }).expect(201)).body.data;
      expect(r.permissions.sort()).toEqual(['project:read', 'warehouse:write']);
      expect(r.menus).toEqual(['/inventory']);
      const cat = (await request(http).get('/api/v1/roles/catalog').set(as('admin')).expect(200)).body.data;
      expect(cat.modules.map((m: any) => m.key)).toContain('procurement');
      const list = (await request(http).get('/api/v1/roles').set(as('admin')).expect(200)).body.data;
      expect(list.find((x: any) => x.name === 'Administrator')).toMatchObject({ system: true });
      expect(list.find((x: any) => x.name === 'Staf Gudang')).toMatchObject({ users: 0, system: false });
      await request(http).delete(`/api/v1/roles/${r.id}`).set(as('admin')).expect(200);
    });
    it('role Administrator tidak bisa dikurangi aksesnya atau dihapus', async () => {
      const admin = await prisma.role.findFirstOrThrow({ where: { tenantId: tenantIds[0], name: 'Administrator' } });
      await request(http).patch(`/api/v1/roles/${admin.id}`).set(as('admin')).send({ name: 'Administrator', permissions: ['project:read'], menus: ['/projects'] }).expect(200);
      const a = await prisma.role.findUniqueOrThrow({ where: { id: admin.id } });
      expect(a.permissions).toEqual(['*']);
      expect(a.menus).toBeNull();
      await request(http).delete(`/api/v1/roles/${admin.id}`).set(as('admin')).expect(422);
    });
    it('menu role ikut ke sesi user (null = semua menu sesuai hak akses)', async () => {
      const pmRole = await prisma.role.findFirstOrThrow({ where: { tenantId: tenantIds[0], name: 'Project Manager' } });
      const before = (await request(http).post('/api/v1/auth/login').send({ tenant: A, email: `pm@${A}.test`, password: PASS }).expect(201)).body.data.user;
      expect(before.menus).toBeNull();
      await request(http).patch(`/api/v1/roles/${pmRole.id}`).set(as('admin')).send({ name: 'Project Manager', permissions: pmRole.permissions, menus: ['/dashboard', '/projects'] }).expect(200);
      const after = (await request(http).post('/api/v1/auth/login').send({ tenant: A, email: `pm@${A}.test`, password: PASS }).expect(201)).body.data.user;
      expect(after.menus).toEqual(['/dashboard', '/projects']);
      await request(http).patch(`/api/v1/roles/${pmRole.id}`).set(as('admin')).send({ name: 'Project Manager', permissions: pmRole.permissions, menus: null }).expect(200);
    });
  });

  describe('Progres dalam Rupiah', () => {
    it('progres bisa diisi Rp (dibandingkan total RAB) atau %, tidak boleh melebihi RAB', async () => {
      const t = (await request(http).post('/api/v1/tenders').set(as('admin')).send({ title: 'Tender progres Rp' }).expect(201)).body.data;
      await request(http).put(`/api/v1/tenders/${t.id}/items`).set(as('admin')).send({ items: [
        { section: 'A', code: 'A.1', description: 'Galian', unit: 'm3', category: 'LABOR', quantity: '100', unitCost: '50000' },
        { section: 'B', code: 'B.1', description: 'Beton', unit: 'm3', category: 'MATERIAL', quantity: '20', unitCost: '1000000' },
      ] }).expect(200);
      await request(http).post(`/api/v1/tenders/${t.id}/submit`).set(as('admin')).expect(201);
      const pid = (await request(http).post(`/api/v1/tenders/${t.id}/decision`).set(as('admin')).send({ decision: 'WON' }).expect(201)).body.data.projectId;
      await request(http).patch(`/api/v1/projects/${pid}`).set(as('admin')).send({ status: 'ACTIVE' }).expect(200);
      const p0 = (await request(http).get(`/api/v1/projects/${pid}`).set(as('admin')).expect(200)).body.data;
      expect(p0.progressBase.source).toBe('RAB');
      const base = Number(p0.progressBase.value);
      expect(base).toBeGreaterThan(0);

      // Rupiah → persen
      const half = (base / 2).toFixed(2);
      const e = (await request(http).post(`/api/v1/projects/${pid}/progress`).set(as('admin')).send({ reportDate: '2026-11-20', plannedValue: (base * 0.6).toFixed(2), actualValue: half }).expect(201)).body.data;
      expect(Number(e.actualPct)).toBeCloseTo(50, 3);
      expect(Number(e.plannedPct)).toBeCloseTo(60, 3);
      expect(Number(e.actualValue)).toBeCloseTo(base / 2, 1);
      expect(Number(e.baseValue)).toBeCloseTo(base, 1);
      // persen → Rupiah
      const e2 = (await request(http).post(`/api/v1/projects/${pid}/progress`).set(as('admin')).send({ reportDate: '2026-11-27', plannedPct: '70', actualPct: '65' }).expect(201)).body.data;
      expect(Number(e2.actualValue)).toBeCloseTo(base * 0.65, 1);
      // melebihi RAB ditolak
      const over = await request(http).post(`/api/v1/projects/${pid}/progress`).set(as('admin')).send({ reportDate: '2026-11-28', plannedPct: '80', actualValue: String(base + 1) }).expect(422);
      expect(over.body.error.code).toBe('PROGRESS_OVER_RAB');
      // salah satu harus diisi
      await request(http).post(`/api/v1/projects/${pid}/progress`).set(as('admin')).send({ reportDate: '2026-11-28', plannedPct: '80' }).expect(422);
      const p1 = (await request(http).get(`/api/v1/projects/${pid}`).set(as('admin'))).body.data;
      expect(Number(p1.progressPct)).toBeCloseTo(65, 3);
    });
  });

  describe('Ukuran request', () => {
    it('impor BQ besar (>100 KB) diterima; melebihi BODY_LIMIT dijawab 413 yang jelas', async () => {
      const t = (await request(http).post('/api/v1/tenders').set(as('admin')).send({ title: 'Tender besar' }).expect(201)).body.data;
      const row = (i: number) => ({ section: 'A. PEKERJAAN', code: `A.${i}`, description: `Pekerjaan uraian panjang nomor ${i} `.repeat(3), unit: 'm3', category: 'MATERIAL', quantity: '12.5', unitCost: '150000' });
      const items = Array.from({ length: 1500 }, (_, i) => row(i + 1));
      expect(JSON.stringify({ items }).length).toBeGreaterThan(200_000);
      await request(http).put(`/api/v1/tenders/${t.id}/items`).set(as('admin')).send({ items }).expect(200);
      const huge = await request(http).put(`/api/v1/tenders/${t.id}/items`).set(as('admin')).set('content-type', 'application/json')
        .send(JSON.stringify({ items: Array.from({ length: 6000 }, (_, i) => row(i + 1)) })).expect(413);
      expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('Hapus proyek', () => {
    it('hanya admin; perlu konfirmasi kode; ikut menghapus RAB/RAP, PR, laporan, file; tender dilepas', async () => {
      const t = await request(http).post('/api/v1/tenders').set(as('admin')).send({ title: 'Tender hapus' }).expect(201);
      await request(http).put(`/api/v1/tenders/${t.body.data.id}/items`).set(as('admin')).send({ items: [{ section: 'A', code: 'A.1', description: 'Galian', unit: 'm3', category: 'LABOR', quantity: '10', unitCost: '50000' }] }).expect(200);
      await request(http).post(`/api/v1/tenders/${t.body.data.id}/submit`).set(as('admin')).expect(201);
      const pid = (await request(http).post(`/api/v1/tenders/${t.body.data.id}/decision`).set(as('admin')).send({ decision: 'WON' }).expect(201)).body.data.projectId;
      const p = (await request(http).get(`/api/v1/projects/${pid}`).set(as('admin'))).body.data;
      const pr = await request(http).post('/api/v1/purchase-requests').set(as('pm')).send({ projectId: pid, items: [{ description: 'Semen', quantity: '10', estimatedPrice: '70000', category: 'MATERIAL' }] }).expect(201);
      await request(http).post(`/api/v1/purchase-requests/${pr.body.data.id}/submit`).set(as('pm')).expect(201);
      await request(http).post(`/api/v1/projects/${pid}/daily-reports`).set(as('pm')).send({ reportDate: '2026-11-20', weather: 'Cerah', manpower: 5, activities: 'Galian' }).expect(201);
      await request(http).post('/api/v1/files').set(as('admin')).field('entityType', 'Project').field('entityId', pid).attach('files', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'f.png', contentType: 'image/png' }).expect(201);

      await request(http).get(`/api/v1/projects/${pid}/delete-check`).set(as('pm')).expect(403);
      await request(http).delete(`/api/v1/projects/${pid}`).set(as('pm')).expect(403);
      const chk = (await request(http).get(`/api/v1/projects/${pid}/delete-check`).set(as('admin')).expect(200)).body.data;
      expect(chk).toMatchObject({ canDelete: true, blockers: [], tender: t.body.data.number });
      expect(chk.willDelete).toMatchObject({ rab: 1, purchaseRequests: 1, dailyReports: 1, files: 1 });
      const noConfirm = await request(http).delete(`/api/v1/projects/${pid}`).set(as('admin')).expect(422);
      expect(noConfirm.body.error.code).toBe('CONFIRM_REQUIRED');
      await request(http).delete(`/api/v1/projects/${pid}?confirm=${p.code}`).set(as('admin')).expect(200);

      await request(http).get(`/api/v1/projects/${pid}`).set(as('admin')).expect(404);
      const tn = (await request(http).get(`/api/v1/tenders/${t.body.data.id}`).set(as('admin')).expect(200)).body.data;
      expect(tn.projectId).toBeNull();
      expect(await prisma.purchaseRequest.count({ where: { id: pr.body.data.id } })).toBe(0);
      expect(await prisma.approvalRequest.count({ where: { entityId: pr.body.data.id } })).toBe(0);
      expect(await prisma.fileObject.count({ where: { entityId: pid } })).toBe(0);
      const inbox = (await request(http).get('/api/v1/approvals/inbox').set(as('admin'))).body.data;
      expect(inbox.some((x: any) => x.entityId === pr.body.data.id)).toBe(false);
    });
    it('proyek yang sudah punya PO/invoice/jurnal tidak bisa dihapus', async () => {
      const chk = (await request(http).get(`/api/v1/projects/${projectA}/delete-check`).set(as('admin')).expect(200)).body.data;
      expect(chk.canDelete).toBe(false);
      expect(chk.blockers.join(' ')).toMatch(/purchase order/);
      const r = await request(http).delete(`/api/v1/projects/${projectA}?confirm=${chk.project.code}`).set(as('admin')).expect(422);
      expect(r.body.error.code).toBe('PROJECT_HAS_TRANSACTIONS');
    });
  });
});
