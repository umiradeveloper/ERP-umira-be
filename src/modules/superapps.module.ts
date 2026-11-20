import { Body, Controller, Get, Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Post, Put } from '@nestjs/common';
import { IsObject } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService } from '../common/common.service';
import { BusinessError } from '../common/http';

/**
 * Akun ERP Umira diambil dari database SuperApps (tabel `users` + `role`).
 *
 *   SUPERAPPS_DATABASE_URL   mysql://user_readonly:pass@host:3306/superapps   (cukup hak SELECT)
 *   SUPERAPPS_TENANT         slug perusahaan ERP yang memakai user SuperApps (mis. "umira")
 *   SUPERAPPS_ROLE_MAP_FILE  (opsional) path file pemetaan role; default ./superapps-role-map.json
 *   SUPERAPPS_SYNC_INTERVAL_MIN (opsional) sinkron user otomatis tiap N menit
 *
 * Login: email ATAU username + password SuperApps (bcrypt). Hanya user dengan isApproval = 1 dan role
 * yang dipetakan ke role ERP. Akun lokal ERP (mis. admin cadangan) tetap bisa login bila identitasnya
 * tidak ditemukan di SuperApps.
 */

export const SOURCE = 'superapps';

export interface SaUser {
  id_user: string;
  id_role: string | null;
  nama: string | null;
  username: string | null;
  password: string | null;
  email: string | null;
  no_hp: string | null;
  isApproval: number | string | null;
  nama_role: string | null;
}

export type Eligibility = { ok: true; roles: string[] } | { ok: false; reason: string; code: string };

let DUMMY_HASH: string | undefined;

@Injectable()
export class SuperAppsService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('SuperApps');
  private pool?: Pool;
  private roleMap: Record<string, string[]> = {};
  /** Pemetaan dari halaman admin (disimpan di Tenant.settings); bila ada, menggantikan file */
  private dbMap: Record<string, string[]> | null = null;
  private timer?: NodeJS.Timeout;
  private lastSync?: any;

  constructor(private prisma: PrismaService, private audit: AuditService) {}

  get enabled() {
    return !!process.env.SUPERAPPS_DATABASE_URL && !!process.env.SUPERAPPS_TENANT;
  }
  get tenantSlug() {
    return process.env.SUPERAPPS_TENANT?.trim().toLowerCase() || null;
  }

  onModuleInit() {
    this.loadRoleMap();
    this.loadDbMap().catch((e) => this.log.warn(`Gagal memuat pemetaan role dari database: ${e.message}`));
    const every = Number(process.env.SUPERAPPS_SYNC_INTERVAL_MIN ?? 0);
    if (this.enabled && every > 0) {
      const run = () => this.syncAll(null).then((r) => this.log.log(`Sinkron user: ${r.created} baru, ${r.updated} diperbarui, ${r.deactivated} dinonaktifkan`)).catch((e) => this.log.warn(e.message));
      this.timer = setInterval(run, every * 60_000);
      setTimeout(run, 10_000);
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.pool?.end().catch(() => undefined);
  }

  loadRoleMap() {
    const file = resolve(process.env.SUPERAPPS_ROLE_MAP_FILE ?? 'superapps-role-map.json');
    if (!existsSync(file)) {
      this.roleMap = {};
      if (this.enabled) this.log.warn(`File pemetaan role tidak ditemukan: ${file}`);
      return;
    }
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    this.roleMap = Object.fromEntries(
      Object.entries(raw).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v)).map(([k, v]) => [k.trim().toLowerCase(), v as string[]]),
    );
  }

  /** Dipakai untuk tes: ganti pemetaan role tanpa file */
  setRoleMap(map: Record<string, string[]>) {
    this.roleMap = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.trim().toLowerCase(), v]));
    this.dbMap = null;
  }

  private lower(map: Record<string, string[]>) {
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [k.trim().toLowerCase(), v]));
  }
  private get activeMap() {
    return this.dbMap ?? this.roleMap;
  }

  private async connectedTenant() {
    return this.tenantSlug ? this.prisma.tenant.findUnique({ where: { slug: this.tenantSlug } }) : null;
  }
  private storedMap(settings: unknown): Record<string, string[]> | null {
    const m = (settings as any)?.superappsRoleMap;
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, string[]>) : null;
  }

  async loadDbMap() {
    const t = await this.connectedTenant();
    const m = t ? this.storedMap(t.settings) : null;
    this.dbMap = m ? this.lower(m) : null;
  }

  /** Pemetaan untuk halaman admin: role SuperApps (beserta jumlah user) → role ERP */
  async getRoleMap(actor: AuthUser) {
    const t = await this.connectedTenant();
    const own = !!t && t.id === actor.tenantId;
    const stored = own ? this.storedMap(t!.settings) : null;
    let fileMap: Record<string, string[]> = {};
    const file = resolve(process.env.SUPERAPPS_ROLE_MAP_FILE ?? 'superapps-role-map.json');
    if (existsSync(file)) {
      try {
        fileMap = Object.fromEntries(Object.entries(JSON.parse(readFileSync(file, 'utf8'))).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))) as Record<string, string[]>;
      } catch {
        fileMap = {};
      }
    }
    const map = stored ?? fileMap;
    let saRoles: { name: string; users: number; approved: number }[] = [];
    let saError: string | null = null;
    if (this.enabled && own) {
      try {
        const [rows] = await (await this.db()).query<RowDataPacket[]>(
          `SELECT r.nama_role AS name, COUNT(u.id_user) AS users, SUM(CASE WHEN u.isApproval = 1 THEN 1 ELSE 0 END) AS approved
           FROM role r LEFT JOIN users u ON u.id_role = r.id_role GROUP BY r.id_role, r.nama_role ORDER BY r.nama_role`,
        );
        saRoles = rows.map((r) => ({ name: String(r.name ?? '').trim(), users: Number(r.users ?? 0), approved: Number(r.approved ?? 0) })).filter((r) => r.name);
      } catch (e: any) {
        saError = 'Database SuperApps tidak bisa dihubungi, daftar role diambil dari pemetaan yang tersimpan.';
        this.log.warn(`Daftar role SuperApps gagal: ${e.message}`);
      }
    }
    // gabungkan role yang ada di SuperApps dengan yang sudah ada di pemetaan
    const names = new Map<string, { name: string; users: number | null; approved: number | null }>();
    for (const r of saRoles) names.set(r.name.toLowerCase(), { name: r.name, users: r.users, approved: r.approved });
    for (const k of Object.keys(map)) if (!names.has(k.trim().toLowerCase())) names.set(k.trim().toLowerCase(), { name: k.trim(), users: saRoles.length ? 0 : null, approved: saRoles.length ? 0 : null });
    const lowerMap = this.lower(map);
    return {
      enabled: this.enabled && own,
      source: stored ? 'database' : 'file',
      saError,
      roles: [...names.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r, erpRoles: lowerMap[r.name.toLowerCase()] ?? [] })),
    };
  }

  async saveRoleMap(actor: AuthUser, map: Record<string, string[]>) {
    const t = await this.connectedTenant();
    if (!t || t.id !== actor.tenantId) throw new BusinessError('Pemetaan SuperApps hanya untuk perusahaan yang terhubung ke SuperApps', 'SUPERAPPS_TENANT_MISMATCH');
    const erp = new Set((await this.prisma.role.findMany({ where: { tenantId: t.id }, select: { name: true } })).map((r) => r.name));
    const clean: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(map ?? {})) {
      const key = k.trim();
      if (!key || key.startsWith('_') || key.length > 120) continue;
      if (!Array.isArray(v)) throw new BusinessError(`Pemetaan "${key}" tidak valid`);
      const roles = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
      const unknown = roles.filter((r) => !erp.has(r));
      if (unknown.length) throw new BusinessError(`Role ERP tidak ada: ${unknown.join(', ')}`);
      clean[key] = roles;
    }
    await this.prisma.tenant.update({ where: { id: t.id }, data: { settings: { ...((t.settings as object) ?? {}), superappsRoleMap: clean } } });
    this.dbMap = this.lower(clean);
    await this.audit.log(actor, 'UPDATE', 'SuperAppsRoleMap', t.id, { roles: Object.keys(clean).length } as any);
    return { ok: true, roles: Object.keys(clean).length };
  }

  /** Ikut ganti nama role ERP di pemetaan saat role di-rename */
  async renameErpRole(tenantId: string, from: string, to: string) {
    const t = await this.connectedTenant();
    if (!t || t.id !== tenantId) return;
    const m = this.storedMap(t.settings);
    if (!m) return;
    const next = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.map((x) => (x === from ? to : x))]));
    await this.prisma.tenant.update({ where: { id: t.id }, data: { settings: { ...((t.settings as object) ?? {}), superappsRoleMap: next } } });
    this.dbMap = this.lower(next);
  }

  async isErpRoleMapped(tenantId: string, name: string) {
    const t = await this.connectedTenant();
    if (!t || t.id !== tenantId) return false;
    const m = this.storedMap(t.settings) ?? this.roleMap;
    return Object.values(m).some((v) => v.includes(name));
  }

  private async db(): Promise<Pool> {
    if (!this.pool) {
      const mysql = await import('mysql2/promise');
      this.pool = mysql.createPool({ uri: process.env.SUPERAPPS_DATABASE_URL!, connectionLimit: 5, connectTimeout: 10_000, dateStrings: true });
    }
    return this.pool;
  }

  private async query(sql: string, params: unknown[] = []): Promise<SaUser[]> {
    try {
      const [rows] = await (await this.db()).query<RowDataPacket[]>(sql, params);
      return rows as unknown as SaUser[];
    } catch (e: any) {
      this.log.error(`Query SuperApps gagal: ${e.code ?? ''} ${e.message}`);
      throw new BusinessError('Database SuperApps tidak bisa dihubungi. Coba lagi beberapa saat.', 'SUPERAPPS_UNAVAILABLE');
    }
  }

  private readonly SELECT = `SELECT u.id_user, u.id_role, u.nama, u.username, u.password, u.email, u.no_hp, u.isApproval, r.nama_role
    FROM users u LEFT JOIN role r ON r.id_role = u.id_role`;

  findByIdentifier(identifier: string) {
    const id = identifier.trim().toLowerCase();
    return this.query(`${this.SELECT} WHERE LOWER(TRIM(u.email)) = ? OR LOWER(TRIM(u.username)) = ? LIMIT 10`, [id, id]);
  }

  allUsers() {
    return this.query(this.SELECT);
  }

  /** Cocokkan password dengan salah satu kandidat (email/username bisa duplikat di SuperApps). */
  async verify(candidates: SaUser[], password: string): Promise<SaUser | null> {
    for (const c of candidates) {
      if (!c.password) continue;
      const hash = c.password.replace(/^\$2y\$/, '$2a$');
      if (await bcrypt.compare(password, hash).catch(() => false)) return c;
    }
    if (!candidates.length) await bcrypt.compare(password, (DUMMY_HASH ??= bcrypt.hashSync('dummy-password', 10))).catch(() => false); // samakan waktu respons
    return null;
  }

  eligibility(u: SaUser): Eligibility {
    if (Number(u.isApproval) !== 1) return { ok: false, code: 'SUPERAPPS_NOT_APPROVED', reason: 'Akun SuperApps Anda belum disetujui.' };
    const roleName = (u.nama_role ?? '').trim();
    const roles = this.activeMap[roleName.toLowerCase()];
    if (!roles?.length) return { ok: false, code: 'SUPERAPPS_ROLE_DENIED', reason: roleName ? `Role "${roleName}" tidak memiliki akses ke ERP Umira.` : 'Akun SuperApps Anda belum memiliki role.' };
    return { ok: true, roles };
  }

  /** Buat/perbarui user ERP dari data SuperApps dan samakan role-nya. */
  async provision(tenantId: string, u: SaUser, roles: string[]) {
    const erpRoles = await this.prisma.role.findMany({ where: { tenantId, name: { in: roles } } });
    if (!erpRoles.length) throw new BusinessError(`Role ERP ${roles.join(', ')} belum ada di perusahaan ini.`, 'SUPERAPPS_ROLE_DENIED');
    const name = (u.username?.trim() || u.nama?.trim() || u.email?.trim() || 'User SuperApps').replace(/\s+/g, ' ').slice(0, 190);
    let email = (u.email ?? '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) email = `${u.id_user}@superapps.local`;
    const title = u.nama_role?.trim() || null;

    let user = await this.prisma.user.findUnique({ where: { tenantId_externalSource_externalId: { tenantId, externalSource: SOURCE, externalId: u.id_user } } });
    const byEmail = await this.prisma.user.findUnique({ where: { tenantId_email: { tenantId, email } } });
    let created = false;
    if (!user && byEmail && !byEmail.externalId) {
      // Akun lokal dengan email sama → ditautkan ke SuperApps
      user = await this.prisma.user.update({ where: { id: byEmail.id }, data: { externalSource: SOURCE, externalId: u.id_user, passwordHash: null } });
    }
    if (byEmail && user && byEmail.id !== user.id) email = `${u.id_user}@superapps.local`; // email dipakai akun lain
    if (!user && byEmail && byEmail.externalId) email = `${u.id_user}@superapps.local`;

    if (!user) {
      user = await this.prisma.user.create({ data: { tenantId, email, name, title, passwordHash: null, externalSource: SOURCE, externalId: u.id_user } });
      created = true;
    } else {
      const changed = user.name !== name || user.email !== email || user.title !== title;
      if (changed) user = await this.prisma.user.update({ where: { id: user.id }, data: { name, email, title } });
    }

    // Samakan role: role ERP mengikuti SuperApps
    const current = await this.prisma.membership.findMany({ where: { userId: user.id } });
    const want = new Set(erpRoles.map((r) => r.id));
    const have = new Set(current.map((m) => m.roleId));
    const rolesChanged = want.size !== have.size || [...want].some((x) => !have.has(x));
    if (rolesChanged) {
      await this.prisma.$transaction([
        this.prisma.membership.deleteMany({ where: { userId: user.id } }),
        this.prisma.membership.createMany({ data: [...want].map((roleId) => ({ tenantId, userId: user!.id, roleId })) }),
      ]);
    }
    return { user, created, changed: rolesChanged };
  }

  /** Sinkron semua user SuperApps yang berhak; nonaktifkan user tertaut yang tidak lagi berhak. */
  async syncAll(actor: AuthUser | null) {
    if (!this.enabled) throw new BusinessError('Integrasi SuperApps belum diatur (SUPERAPPS_DATABASE_URL & SUPERAPPS_TENANT)', 'SUPERAPPS_NOT_CONFIGURED');
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: this.tenantSlug! } });
    if (!tenant) throw new BusinessError(`Perusahaan "${this.tenantSlug}" belum dibuat di ERP`, 'SUPERAPPS_TENANT_MISSING');
    if (actor && actor.tenantId !== tenant.id) throw new BusinessError('Sinkron SuperApps hanya untuk perusahaan yang terhubung', 'SUPERAPPS_TENANT_MISMATCH');
    const rows = await this.allUsers();
    const r = { total: rows.length, created: 0, updated: 0, unchanged: 0, skipped: 0, deactivated: 0, byReason: {} as Record<string, number>, at: new Date().toISOString() };
    const keep = new Set<string>();
    for (const u of rows) {
      const e = this.eligibility(u);
      if (!e.ok) {
        r.skipped++;
        const key = e.code === 'SUPERAPPS_NOT_APPROVED' ? 'Belum disetujui' : `Role tanpa akses: ${(u.nama_role ?? '-').trim() || '-'}`;
        r.byReason[key] = (r.byReason[key] ?? 0) + 1;
        continue;
      }
      try {
        const p = await this.provision(tenant.id, u, e.roles);
        keep.add(p.user.id);
        if (p.created) r.created++;
        else if (p.changed) r.updated++;
        else r.unchanged++;
      } catch (err: any) {
        r.skipped++;
        r.byReason[err.message] = (r.byReason[err.message] ?? 0) + 1;
      }
    }
    // Offboarding: user tertaut yang sudah tidak berhak dinonaktifkan dan sesinya dicabut
    const linked = await this.prisma.user.findMany({ where: { tenantId: tenant.id, externalSource: SOURCE, isActive: true } });
    for (const u of linked) {
      if (keep.has(u.id)) continue;
      await this.prisma.user.update({ where: { id: u.id }, data: { isActive: false } });
      await this.prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      r.deactivated++;
    }
    this.lastSync = r;
    await this.audit.log({ tenantId: tenant.id, userId: (actor?.userId ?? null) as any, name: actor?.name ?? 'Sinkron otomatis' }, 'SYNC', 'User', SOURCE, r as any);
    return r;
  }

  status() {
    let host: string | null = null;
    try {
      host = this.enabled ? new URL(process.env.SUPERAPPS_DATABASE_URL!).host : null;
    } catch {
      host = null;
    }
    return { enabled: this.enabled, tenant: this.tenantSlug, host, mappedRoles: Object.values(this.activeMap).filter((v) => v.length).length, roleMapSource: this.dbMap ? 'database' : 'file', lastSync: this.lastSync ?? null };
  }
}

class RoleMapDto {
  /** { "Nama role SuperApps": ["Role ERP", ...] } — [] = tidak boleh masuk ERP */
  @IsObject() map!: Record<string, string[]>;
}

@ApiTags('SuperApps')
@Controller('superapps')
export class SuperAppsController {
  constructor(private svc: SuperAppsService) {}

  @Get('status') @Perm('admin:read')
  status() {
    return this.svc.status();
  }

  @Get('role-map') @Perm('admin:read')
  roleMap(@CurrentUser() u: AuthUser) {
    return this.svc.getRoleMap(u);
  }

  @Put('role-map') @Perm('admin:write')
  saveRoleMap(@CurrentUser() u: AuthUser, @Body() dto: RoleMapDto) {
    return this.svc.saveRoleMap(u, dto.map);
  }

  @Post('sync-users') @Perm('admin:write')
  sync(@CurrentUser() u: AuthUser) {
    return this.svc.syncAll(u);
  }
}

@Global()
@Module({ controllers: [SuperAppsController], providers: [SuperAppsService], exports: [SuperAppsService] })
export class SuperAppsModule {}
