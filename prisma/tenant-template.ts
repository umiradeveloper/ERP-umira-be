/**
 * Template perusahaan baru: role standar, bagan akun dan workflow approval.
 * Dipakai oleh seed demo dan skrip pembuatan perusahaan (create-tenant).
 */
import { PrismaClient } from '@prisma/client';

export const ROLES: Record<string, { desc: string; perms: string[] }> = {
  Administrator: { desc: 'Tenant owner — akses penuh', perms: ['*'] },
  Direktur: {
    desc: 'Portfolio, approval strategis',
    perms: ['project:read', 'tender:read', 'cost:read', 'finance:read', 'accounting:read', 'procurement:read', 'asset:read', 'master:read', 'audit:read', 'warehouse:read'],
  },
  'Project Manager': { desc: 'Kontrak, jadwal, budget, progres, VO', perms: ['project:write', 'tender:read', 'procurement:read', 'cost:read', 'asset:read', 'master:read', 'warehouse:read'] },
  'Site Engineer': { desc: 'Progres, laporan harian, PR, pemakaian material', perms: ['project:write', 'procurement:read', 'master:read', 'warehouse:write'] },
  Estimator: { desc: 'BQ, AHSP, tender', perms: ['tender:write', 'master:write', 'project:read'] },
  Procurement: { desc: 'Supplier, PO, penerimaan', perms: ['procurement:write', 'master:write', 'project:read', 'warehouse:write'] },
  'Cost Controller': { desc: 'Budget, commitment, actual, forecast', perms: ['cost:read', 'project:read', 'procurement:read', 'warehouse:read'] },
  Finance: { desc: 'Kas, bank, AR/AP', perms: ['finance:write', 'accounting:read', 'project:read', 'procurement:read'] },
  Accountant: { desc: 'GL, jurnal, closing', perms: ['accounting:write', 'finance:read', 'project:read'] },
  'Asset Manager': { desc: 'Aset & maintenance', perms: ['asset:write', 'project:read', 'warehouse:write'] },
  Auditor: {
    desc: 'Read-only + audit trail',
    perms: ['project:read', 'tender:read', 'cost:read', 'finance:read', 'accounting:read', 'procurement:read', 'asset:read', 'master:read', 'audit:read', 'warehouse:read'],
  },
};

export const COA: [string, string, string][] = [
  ['1101', 'Kas & Bank', 'ASSET'],
  ['1201', 'Piutang Usaha', 'ASSET'],
  ['1202', 'Piutang Retensi', 'ASSET'],
  ['1301', 'PPN Masukan', 'ASSET'],
  ['1501', 'Peralatan & Alat Berat', 'ASSET'],
  ['2101', 'Hutang Usaha', 'LIABILITY'],
  ['2201', 'PPN Keluaran', 'LIABILITY'],
  ['2301', 'Uang Muka Proyek', 'LIABILITY'],
  ['3101', 'Modal Disetor', 'EQUITY'],
  ['3201', 'Laba Ditahan', 'EQUITY'],
  ['4101', 'Pendapatan Kontrak', 'REVENUE'],
  ['5101', 'Biaya Material', 'EXPENSE'],
  ['5102', 'Biaya Upah', 'EXPENSE'],
  ['5103', 'Biaya Alat', 'EXPENSE'],
  ['5104', 'Biaya Subkontraktor', 'EXPENSE'],
  ['5105', 'Biaya Overhead Proyek', 'EXPENSE'],
  ['5199', 'Biaya Lain-lain', 'EXPENSE'],
  ['6101', 'Beban Umum & Administrasi', 'EXPENSE'],
];

export const WORKFLOWS = [
  { entityType: 'PR', name: 'Approval Purchase Request', steps: [{ step: 1, roleName: 'Project Manager', minAmount: '0' }, { step: 2, roleName: 'Direktur', minAmount: '250000000' }] },
  { entityType: 'PO', name: 'Approval Purchase Order', steps: [{ step: 1, roleName: 'Project Manager', minAmount: '0' }, { step: 2, roleName: 'Direktur', minAmount: '500000000' }] },
  { entityType: 'VO', name: 'Approval Variation Order', steps: [{ step: 1, roleName: 'Direktur', minAmount: '0' }] },
];

/** Isi role, COA dan workflow untuk tenant yang baru dibuat. Mengembalikan id role per nama. */
export async function applyTenantTemplate(prisma: PrismaClient, tenantId: string) {
  const roleIds: Record<string, string> = {};
  for (const [name, r] of Object.entries(ROLES)) {
    roleIds[name] = (await prisma.role.create({ data: { tenantId, name, description: r.desc, permissions: r.perms } })).id;
  }
  await prisma.account.createMany({ data: COA.map(([code, name, accountType]) => ({ tenantId, code, name, accountType: accountType as any })) });
  await prisma.workflowDefinition.createMany({ data: WORKFLOWS.map((w) => ({ tenantId, entityType: w.entityType as any, name: w.name, version: 1, steps: w.steps })) });
  return roleIds;
}
