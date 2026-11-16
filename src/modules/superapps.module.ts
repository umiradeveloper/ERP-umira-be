import { Controller, Get, Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Post } from '@nestjs/common';
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
    const roles = this.roleMap[roleName.toLowerCase()];
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
    return { enabled: this.enabled, tenant: this.tenantSlug, host, mappedRoles: Object.keys(this.roleMap).length, lastSync: this.lastSync ?? null };
  }
}

@ApiTags('SuperApps')
@Controller('superapps')
export class SuperAppsController {
  constructor(private svc: SuperAppsService) {}

  @Get('status') @Perm('admin:read')
  status() {
    return this.svc.status();
  }

  @Post('sync-users') @Perm('admin:write')
  sync(@CurrentUser() u: AuthUser) {
    return this.svc.syncAll(u);
  }
}

@Global()
@Module({ controllers: [SuperAppsController], providers: [SuperAppsService], exports: [SuperAppsService] })
export class SuperAppsModule {}
