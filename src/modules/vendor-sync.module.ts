import { Controller, Get, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService } from '../common/common.service';
import { BusinessError } from '../common/http';

/**
 * Sinkron data vendor (supplier) dari endpoint eksternal.
 *
 * Konfigurasi (.env):
 *   VENDOR_SOURCE_URL        URL endpoint (GET, respons JSON)
 *   VENDOR_SOURCE_USER       username Basic Auth
 *   VENDOR_SOURCE_PASSWORD   password Basic Auth
 *   VENDOR_SOURCE_LIST_PATH  (opsional) lokasi array vendor di JSON, mis. "data" atau "data.items".
 *                            Kosong = otomatis (array di root, atau properti data/items/results/vendors).
 *   VENDOR_FIELD_MAP         (opsional) JSON pemetaan field, mis. {"code":"vendor_code","name":"vendor_name"}.
 *                            Field yang tidak dipetakan ditebak dari nama umum.
 *   VENDOR_SYNC_TENANT       (opsional) slug perusahaan untuk sinkron otomatis terjadwal
 *   VENDOR_SYNC_INTERVAL_MIN (opsional) interval sinkron otomatis dalam menit (0/kosong = manual saja)
 *   VENDOR_MANUAL_INPUT      "false" = input vendor manual & impor Excel dimatikan di aplikasi
 *   VENDOR_SOURCE_TIMEOUT_MS (opsional) default 20000
 */

type Field = 'code' | 'name' | 'category' | 'taxNumber' | 'email' | 'phone' | 'paymentTerm';
const GUESS: Record<Field, string[]> = {
  code: ['code', 'kode', 'vendor_code', 'vendorCode', 'kode_vendor', 'supplier_code', 'supplierCode', 'kode_supplier', 'id'],
  name: ['name', 'nama', 'vendor_name', 'vendorName', 'nama_vendor', 'supplier_name', 'supplierName', 'nama_supplier', 'company_name'],
  category: ['category', 'kategori', 'type', 'jenis', 'vendor_type', 'vendorType'],
  taxNumber: ['npwp', 'tax_number', 'taxNumber', 'tax_id', 'taxId'],
  email: ['email', 'e_mail', 'mail'],
  phone: ['phone', 'telepon', 'telp', 'no_telp', 'phone_number', 'phoneNumber', 'mobile', 'hp'],
  paymentTerm: ['payment_term', 'paymentTerm', 'termin', 'top', 'term_of_payment', 'payment_terms'],
};

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: { index: number; reason: string }[];
  at: string;
}

function get(obj: any, path: string) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

@Injectable()
export class VendorSyncService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('VendorSync');
  private timer?: NodeJS.Timeout;
  private last = new Map<string, SyncResult>();
  private running = new Set<string>();

  constructor(private prisma: PrismaService, private audit: AuditService) {}

  get configured() {
    return !!process.env.VENDOR_SOURCE_URL;
  }
  get manualAllowed() {
    return process.env.VENDOR_MANUAL_INPUT !== 'false';
  }

  onModuleInit() {
    const every = Number(process.env.VENDOR_SYNC_INTERVAL_MIN ?? 0);
    const slug = process.env.VENDOR_SYNC_TENANT;
    if (!this.configured || !every || !slug) return;
    const run = async () => {
      const t = await this.prisma.tenant.findUnique({ where: { slug } });
      if (!t) return this.log.warn(`VENDOR_SYNC_TENANT "${slug}" tidak ditemukan`);
      const r = await this.sync(t.id, { userId: null, name: 'Sinkron otomatis' });
      this.log.log(`Sinkron vendor ${slug}: ${r.created} baru, ${r.updated} diperbarui, ${r.skipped.length} dilewati`);
    };
    this.timer = setInterval(() => run().catch((e) => this.log.warn(e.message)), every * 60_000);
    setTimeout(() => run().catch((e) => this.log.warn(e.message)), 5_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async status(tenantId: string) {
    if (!this.last.has(tenantId)) {
      const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const saved = (t?.settings as any)?.vendorSync;
      if (saved) this.last.set(tenantId, saved);
    }
    return {
      configured: this.configured,
      manualInput: this.manualAllowed,
      source: this.configured ? new URL(process.env.VENDOR_SOURCE_URL!).host : null,
      intervalMin: Number(process.env.VENDOR_SYNC_INTERVAL_MIN ?? 0) || null,
      lastSync: this.last.get(tenantId) ?? null,
    };
  }

  /** Ambil daftar vendor dari endpoint (Basic Auth). */
  async fetchVendors(): Promise<any[]> {
    const url = process.env.VENDOR_SOURCE_URL;
    if (!url) throw new BusinessError('Endpoint vendor belum diatur (VENDOR_SOURCE_URL)', 'VENDOR_SOURCE_NOT_CONFIGURED');
    const headers: Record<string, string> = { accept: 'application/json' };
    const user = process.env.VENDOR_SOURCE_USER;
    if (user !== undefined && user !== '') {
      headers.authorization = 'Basic ' + Buffer.from(`${user}:${process.env.VENDOR_SOURCE_PASSWORD ?? ''}`).toString('base64');
    }
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(Number(process.env.VENDOR_SOURCE_TIMEOUT_MS ?? 20_000)) });
    } catch (e: any) {
      throw new BusinessError(`Endpoint vendor tidak bisa dihubungi: ${e.cause?.code ?? e.message}`, 'VENDOR_SOURCE_UNREACHABLE');
    }
    if (res.status === 401 || res.status === 403) throw new BusinessError('Endpoint vendor menolak login (periksa user/password Basic Auth)', 'VENDOR_SOURCE_AUTH');
    if (!res.ok) throw new BusinessError(`Endpoint vendor membalas HTTP ${res.status}`, 'VENDOR_SOURCE_HTTP');
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new BusinessError('Respons endpoint vendor bukan JSON', 'VENDOR_SOURCE_FORMAT');
    }
    return this.extractList(body);
  }

  extractList(body: any): any[] {
    const path = process.env.VENDOR_SOURCE_LIST_PATH;
    const list = path ? get(body, path) : Array.isArray(body) ? body : ['data', 'items', 'results', 'vendors', 'suppliers', 'data.items', 'data.data'].map((p) => get(body, p)).find(Array.isArray);
    if (!Array.isArray(list)) throw new BusinessError('Daftar vendor tidak ditemukan di respons (atur VENDOR_SOURCE_LIST_PATH)', 'VENDOR_SOURCE_FORMAT');
    return list;
  }

  /** Petakan satu objek vendor eksternal ke field supplier. */
  mapVendor(v: any): { ok: true; data: Record<Field, any> } | { ok: false; reason: string } {
    let map: Partial<Record<Field, string>> = {};
    if (process.env.VENDOR_FIELD_MAP) {
      try {
        map = JSON.parse(process.env.VENDOR_FIELD_MAP);
      } catch {
        throw new BusinessError('VENDOR_FIELD_MAP bukan JSON yang valid', 'VENDOR_SOURCE_CONFIG');
      }
    }
    const pick = (f: Field) => {
      if (map[f]) return get(v, map[f]!);
      const k = GUESS[f].find((k) => v?.[k] !== undefined && v?.[k] !== null && v?.[k] !== '');
      return k ? v[k] : undefined;
    };
    const str = (x: any) => (x === undefined || x === null ? undefined : String(x).trim() || undefined);
    const rawCode = str(pick('code'));
    const name = str(pick('name'));
    if (!rawCode) return { ok: false, reason: 'kode vendor kosong' };
    if (!name) return { ok: false, reason: `nama vendor kosong (${rawCode})` };
    // Kode internal: huruf besar, angka, minus (2–20)
    let code = rawCode.toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
    if (code.length < 2) code = `V-${code}`.slice(0, 20);
    const email = str(pick('email'));
    const termRaw = pick('paymentTerm');
    const term = termRaw === undefined || termRaw === null || termRaw === '' ? undefined : parseInt(String(termRaw).replace(/\D+/g, ''), 10);
    return {
      ok: true,
      data: {
        code,
        name: name.slice(0, 190),
        category: str(pick('category'))?.slice(0, 190),
        taxNumber: str(pick('taxNumber'))?.slice(0, 190),
        email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 190) : undefined,
        phone: str(pick('phone'))?.slice(0, 190),
        paymentTerm: Number.isFinite(term) && term! >= 0 ? term : undefined,
      },
    };
  }

  /** Upsert vendor ke tenant: kode sama → diperbarui, kode baru → dibuat. Vendor lokal lain tidak dihapus. */
  async sync(tenantId: string, actor: { userId: string | null; name: string }): Promise<SyncResult> {
    if (this.running.has(tenantId)) throw new BusinessError('Sinkron vendor sedang berjalan', 'VENDOR_SYNC_RUNNING');
    this.running.add(tenantId);
    try {
      const list = await this.fetchVendors();
      const existing = await this.prisma.supplier.findMany({ where: { tenantId } });
      const byCode = new Map(existing.map((s) => [s.code, s]));
      const seen = new Set<string>();
      const r: SyncResult = { fetched: list.length, created: 0, updated: 0, unchanged: 0, skipped: [], at: new Date().toISOString() };
      for (let i = 0; i < list.length; i++) {
        const m = this.mapVendor(list[i]);
        if (!m.ok) {
          r.skipped.push({ index: i + 1, reason: m.reason });
          continue;
        }
        const d = m.data;
        if (seen.has(d.code)) {
          r.skipped.push({ index: i + 1, reason: `kode ${d.code} duplikat di sumber` });
          continue;
        }
        seen.add(d.code);
        const data = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as any;
        const ex = byCode.get(d.code);
        if (!ex) {
          await this.prisma.supplier.create({ data: { tenantId, ...data } });
          r.created++;
        } else {
          const changed = Object.keys(data).some((k) => (ex as any)[k] !== data[k]) || ex.deletedAt !== null;
          if (changed) {
            await this.prisma.supplier.update({ where: { id: ex.id }, data: { ...data, deletedAt: null } });
            r.updated++;
          } else r.unchanged++;
        }
      }
      this.last.set(tenantId, r);
      const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const settings = { ...((t?.settings as any) ?? {}), vendorSync: { ...r, skipped: r.skipped.slice(0, 200) } };
      await this.prisma.tenant.update({ where: { id: tenantId }, data: { settings } });
      await this.audit.log({ tenantId, userId: actor.userId as any, name: actor.name }, 'SYNC', 'Supplier', 'vendor-source', {
        fetched: r.fetched, created: r.created, updated: r.updated, skipped: r.skipped.length,
      });
      return r;
    } finally {
      this.running.delete(tenantId);
    }
  }
}

@ApiTags('Master Data & Admin')
@Controller('suppliers/sync')
export class VendorSyncController {
  constructor(private svc: VendorSyncService) {}

  @Get() @Perm('master:read', 'procurement:read')
  status(@CurrentUser() u: AuthUser) {
    return this.svc.status(u.tenantId);
  }

  @Post() @Perm('master:write', 'procurement:write')
  sync(@CurrentUser() u: AuthUser) {
    return this.svc.sync(u.tenantId, { userId: u.userId, name: u.name });
  }
}

@Module({ controllers: [VendorSyncController], providers: [VendorSyncService], exports: [VendorSyncService] })
export class VendorSyncModule {}
