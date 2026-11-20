/**
 * Katalog hak akses yang bisa diatur per role dari halaman admin.
 * Setiap modul punya level "read" (lihat) dan/atau "write" (kelola, otomatis termasuk lihat).
 */
export const PERMISSION_MODULES: { key: string; label: string; levels: ('read' | 'write')[] }[] = [
  { key: 'tender', label: 'Tender & RAB', levels: ['read', 'write'] },
  { key: 'project', label: 'Proyek, RAP, progres & laporan harian', levels: ['read', 'write'] },
  { key: 'cost', label: 'Cost control', levels: ['read'] },
  { key: 'procurement', label: 'Pengadaan (PR, RFQ, PO)', levels: ['read', 'write'] },
  { key: 'warehouse', label: 'Gudang & stok', levels: ['read', 'write'] },
  { key: 'asset', label: 'Aset & alat', levels: ['read', 'write'] },
  { key: 'finance', label: 'Penagihan, piutang & hutang', levels: ['read', 'write'] },
  { key: 'accounting', label: 'Jurnal & laporan keuangan', levels: ['read', 'write'] },
  { key: 'master', label: 'Customer & supplier', levels: ['read', 'write'] },
  { key: 'admin', label: 'User, role & alur approval', levels: ['read', 'write'] },
  { key: 'audit', label: 'Audit log', levels: ['read'] },
];

export const VALID_PERMISSIONS = new Set(PERMISSION_MODULES.flatMap((m) => m.levels.map((l) => `${m.key}:${l}`)));

/** Menu yang ditampilkan untuk gabungan role: null = semua (sesuai permission). */
export function menusFor(roles: { permissions: unknown; menus: unknown }[]): string[] | null {
  if (!roles.length) return [];
  if (roles.some((r) => (r.permissions as string[] | null)?.includes('*') || !Array.isArray(r.menus))) return null;
  return [...new Set(roles.flatMap((r) => r.menus as string[]))];
}
