import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { CostCategory, Prisma, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, round2, SequenceService, sumD, ZERO } from '../common/common.service';
import { BusinessError } from '../common/http';

const CATEGORIES: CostCategory[] = ['MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'OTHER'];
const COMMITTED_PO = ['APPROVED', 'ISSUED', 'PARTIAL_RECEIPT', 'RECEIVED'] as const;

class ProjectDto {
  @IsString() name!: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() managerName?: string;
  @IsNumberString() contractValue!: string;
  @IsOptional() @IsNumberString() retentionPct?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}
class ProjectPatchDto {
  @IsOptional() @IsIn(['SETUP', 'ACTIVE', 'ON_HOLD', 'COMPLETION', 'CLOSED', 'CANCELLED']) status?: ProjectStatus;
  @IsOptional() @IsString() managerName?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  /** id file foto proyek; kirim "" untuk menghapus */
  @IsOptional() @IsString() coverFileId?: string;
  /** Judul foto proyek; kirim "" untuk menghapus */
  @IsOptional() @IsString() @MaxLength(190) coverTitle?: string;
}
class RapItemDto {
  @IsOptional() @IsString() bqItemId?: string;
  @IsOptional() @IsString() @MaxLength(500) section?: string;
  @IsOptional() @IsString() @MaxLength(100) code?: string;
  @IsString() description!: string;
  @IsOptional() @IsString() unit?: string;
  @IsIn(['MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'OTHER']) category!: CostCategory;
  @IsNumberString() quantity!: string;
  @IsNumberString() unitRate!: string;
}
class RapDto {
  @ValidateNested({ each: true }) @Type(() => RapItemDto) items!: RapItemDto[];
}
class ProgressDto {
  @IsDateString() reportDate!: string;
  @IsNumberString() plannedPct!: string;
  @IsNumberString() actualPct!: string;
  @IsOptional() @IsString() notes?: string;
}
class DailyReportDto {
  @IsDateString() reportDate!: string;
  @IsOptional() @IsString() weather?: string;
  @IsInt() @Min(0) manpower!: number;
  @IsString() activities!: string;
  @IsOptional() @IsString() issues?: string;
}

const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  SETUP: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ON_HOLD', 'COMPLETION'],
  ON_HOLD: ['ACTIVE', 'CANCELLED'],
  COMPLETION: ['CLOSED', 'ACTIVE'],
  CLOSED: [],
  CANCELLED: [],
};

type Bucket = { budget: Prisma.Decimal; commitment: Prisma.Decimal; actual: Prisma.Decimal };

/**
 * Cost control (PRD §5.6). Budget, commitment, actual dan forecast adalah konsep terpisah:
 * - Budget     : baseline approved (revisi tertinggi)
 * - Commitment : nilai PO approved yang BELUM ditagih supplier → (qty − invoicedQty) × harga
 * - Actual     : biaya diakui (supplier invoice posted, expense, dll)
 * - EAC        : actual + commitment + sisa budget (ETC), minimal = actual + commitment
 * Saat invoice diposting, invoicedQty naik → commitment turun & actual naik (tanpa double count).
 */
@Injectable()
export class CostService {
  constructor(private prisma: PrismaService) {}

  async buckets(tenantId: string, projectIds: string[]) {
    const map = new Map<string, Record<string, Bucket>>();
    const get = (pid: string, cat: string) => {
      if (!map.has(pid)) map.set(pid, {});
      const m = map.get(pid)!;
      return (m[cat] ??= { budget: ZERO, commitment: ZERO, actual: ZERO });
    };
    if (projectIds.length === 0) return map;

    const budgets = await this.prisma.budget.findMany({
      where: { tenantId, projectId: { in: projectIds }, isBaseline: true },
      orderBy: { revision: 'desc' },
      include: { items: { select: { category: true, amount: true } } },
    });
    const seen = new Set<string>();
    for (const b of budgets) {
      if (seen.has(b.projectId)) continue;
      seen.add(b.projectId);
      for (const i of b.items) get(b.projectId, i.category).budget = get(b.projectId, i.category).budget.plus(i.amount);
    }

    const poItems = await this.prisma.purchaseOrderItem.findMany({
      where: { tenantId, po: { projectId: { in: projectIds }, status: { in: [...COMMITTED_PO] } } },
      select: { quantity: true, invoicedQty: true, unitPrice: true, category: true, po: { select: { projectId: true } } },
    });
    for (const i of poItems) {
      const open = i.quantity.minus(i.invoicedQty);
      if (open.lte(0)) continue;
      const b = get(i.po.projectId, i.category);
      b.commitment = b.commitment.plus(open.mul(i.unitPrice));
    }

    const actual = await this.prisma.projectCost.groupBy({
      by: ['projectId', 'category'],
      where: { tenantId, projectId: { in: projectIds } },
      _sum: { amount: true },
    });
    for (const a of actual) get(a.projectId, a.category).actual = D(a._sum.amount);

    return map;
  }

  summarize(cats: Record<string, Bucket> = {}) {
    const rows = CATEGORIES.map((category) => {
      const b = cats[category] ?? { budget: ZERO, commitment: ZERO, actual: ZERO };
      const spent = b.actual.plus(b.commitment);
      const etc = Prisma.Decimal.max(b.budget.minus(spent), ZERO);
      const eac = spent.plus(etc);
      const usedPct = b.budget.gt(0) ? spent.div(b.budget).mul(100).toNumber() : spent.gt(0) ? 100 : 0;
      return {
        category, budget: b.budget, commitment: b.commitment, actual: b.actual, etc, eac,
        variance: b.budget.minus(eac), usedPct,
        alert: usedPct >= 100 ? 'OVER' : usedPct >= 80 ? 'WARNING' : 'OK',
      };
    });
    const total = rows.reduce(
      (t, r) => ({
        budget: t.budget.plus(r.budget), commitment: t.commitment.plus(r.commitment), actual: t.actual.plus(r.actual),
        etc: t.etc.plus(r.etc), eac: t.eac.plus(r.eac), variance: t.variance.plus(r.variance),
      }),
      { budget: ZERO, commitment: ZERO, actual: ZERO, etc: ZERO, eac: ZERO, variance: ZERO },
    );
    const usedPct = total.budget.gt(0) ? total.actual.plus(total.commitment).div(total.budget).mul(100).toNumber() : 0;
    return { rows, total: { ...total, usedPct, alert: usedPct >= 100 ? 'OVER' : usedPct >= 80 ? 'WARNING' : 'OK' } };
  }
}

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private seq: SequenceService,
    private audit: AuditService,
    private cost: CostService,
  ) {}

  async list(u: AuthUser) {
    const projects = await this.prisma.project.findMany({
      where: { tenantId: u.tenantId },
      include: { customer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const buckets = await this.cost.buckets(u.tenantId, projects.map((p) => p.id));
    const billed = await this.prisma.customerInvoice.groupBy({
      by: ['projectId'],
      where: { tenantId: u.tenantId, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      _sum: { grossAmount: true },
    });
    const billedMap = new Map(billed.map((b) => [b.projectId, D(b._sum.grossAmount)]));
    const bkpu = await this.bkpu(u.tenantId, projects);
    return projects.map((p) => {
      const { total } = this.cost.summarize(buckets.get(p.id));
      // Tanpa budget baseline, forecast margin belum bisa dihitung
      const hasBudget = total.budget.gt(0);
      const margin = hasBudget ? p.contractValue.minus(total.eac) : null;
      return {
        ...p,
        cost: total,
        billed: billedMap.get(p.id) ?? ZERO,
        forecastMargin: margin,
        forecastMarginPct: margin && p.contractValue.gt(0) ? margin.div(p.contractValue).mul(100).toNumber() : null,
        ...bkpu.get(p.id)!,
      };
    });
  }

  /**
   * BK/PU = Biaya Konstruksi / Pendapatan Usaha.
   * - Awal: budget pertama (RAP revisi terendah) ÷ nilai kontrak awal (kontrak sekarang − VO yang disetujui).
   * - Saat ini: biaya aktual tercatat ÷ pendapatan usaha sesuai progres fisik (progres % × nilai kontrak sekarang).
   */
  async bkpu(tenantId: string, projects: { id: string; contractValue: Prisma.Decimal; progressPct: Prisma.Decimal | number; bkpuPenetapanPct?: Prisma.Decimal | null }[]) {
    const ids = projects.map((p) => p.id);
    const [budgets, vos, actual] = await Promise.all([
      this.prisma.budget.findMany({
        where: { tenantId, projectId: { in: ids } },
        orderBy: [{ revision: 'asc' }, { createdAt: 'asc' }],
        include: { items: { select: { amount: true } } },
      }),
      this.prisma.variationOrder.groupBy({ by: ['projectId'], where: { tenantId, projectId: { in: ids }, status: 'APPROVED' }, _sum: { contractChange: true } }),
      this.prisma.projectCost.groupBy({ by: ['projectId'], where: { tenantId, projectId: { in: ids } }, _sum: { amount: true } }),
    ]);
    const firstBudget = new Map<string, Prisma.Decimal>();
    for (const b of budgets) {
      if (firstBudget.has(b.projectId)) continue;
      firstBudget.set(b.projectId, b.items.reduce((a, i) => a.plus(i.amount), ZERO));
    }
    const voMap = new Map(vos.map((v) => [v.projectId, D(v._sum.contractChange)]));
    const actMap = new Map(actual.map((a) => [a.projectId, D(a._sum.amount)]));
    const ratio = (a: Prisma.Decimal, b: Prisma.Decimal) => (b.gt(0) && a.gt(0) ? a.div(b).mul(100).toDecimalPlaces(2).toNumber() : null);
    return new Map(
      projects.map((p) => {
        const puAwal = p.contractValue.minus(voMap.get(p.id) ?? ZERO);
        const bkAwal = firstBudget.get(p.id) ?? ZERO;
        const puNow = p.contractValue.mul(D(p.progressPct)).div(100).toDecimalPlaces(2);
        const bkNow = actMap.get(p.id) ?? ZERO;
        const awal = ratio(bkAwal, puAwal);
        const now = ratio(bkNow, puNow);
        return [p.id, {
          bkAwal, puAwal, bkpuAwalPct: awal,
          bkSaatIni: bkNow, puSaatIni: puNow, bkpuSaatIniPct: now,
          // Efisiensi (poin %) = BK/PU penetapan (dari RAP yang ditetapkan) − BK/PU saat ini; positif = lebih hemat.
          // Proyek lama tanpa penetapan memakai BK/PU awal yang dihitung.
          efisiensiPct: (() => {
            const base = p.bkpuPenetapanPct !== null && p.bkpuPenetapanPct !== undefined ? Number(p.bkpuPenetapanPct) : awal;
            return base !== null && now !== null ? Math.round((base - now) * 100) / 100 : null;
          })(),
        }] as const;
      }),
    );
  }


  async get(u: AuthUser, id: string) {
    const p = notFound(
      await this.prisma.project.findFirst({
        where: { id, tenantId: u.tenantId },
        include: { customer: true, company: true },
      }),
      'Proyek',
    );
    const [progress, dailyReports, invoices] = await Promise.all([
      this.prisma.progressEntry.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { reportDate: 'asc' } }),
      this.prisma.dailyReport.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { reportDate: 'desc' }, take: 30 }),
      this.prisma.customerInvoice.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { invoiceDate: 'desc' } }),
    ]);
    const buckets = await this.cost.buckets(u.tenantId, [id]);
    const cost = this.cost.summarize(buckets.get(id));
    const bkpu = (await this.bkpu(u.tenantId, [p])).get(p.id)!;
    const rapBudget = await this.prisma.budget.findFirst({ where: { tenantId: u.tenantId, projectId: p.id, isBaseline: true }, orderBy: { revision: 'desc' }, select: { approvedAt: true, _count: { select: { items: true } } } });
    const billedGross = invoices.filter((i) => !['DRAFT', 'CANCELLED'].includes(i.status)).reduce((a, i) => a.plus(i.grossAmount), ZERO);
    const received = invoices.reduce((a, i) => a.plus(i.paidAmount), ZERO);
    return {
      ...p,
      ...bkpu,
      rap: { approvedAt: rapBudget?.approvedAt ?? null, items: rapBudget?._count.items ?? 0 },
      progress,
      dailyReports,
      cost,
      finance: {
        contractValue: p.contractValue,
        billedGross,
        received,
        forecastMargin: cost.total.budget.gt(0) ? p.contractValue.minus(cost.total.eac) : null,
      },
    };
  }

  async bq(u: AuthUser, id: string) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    return this.prisma.bqItem.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { sortOrder: 'asc' } });
  }

  async budget(u: AuthUser, id: string) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    return this.prisma.budget.findFirst({
      where: { tenantId: u.tenantId, projectId: id, isBaseline: true },
      orderBy: { revision: 'desc' },
      include: { items: true },
    });
  }

  /** RAP (Rencana Anggaran Pelaksanaan) disusun seperti RAB dengan RAB sebagai acuan */
  async rap(u: AuthUser, id: string) {
    const p = notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    const [budget, rab] = await Promise.all([
      this.prisma.budget.findFirst({ where: { tenantId: u.tenantId, projectId: id, isBaseline: true }, orderBy: { revision: 'desc' }, include: { items: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } }),
      this.prisma.bqItem.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const totalRab = sumD(rab.map((r) => r.amount));
    const totalRap = sumD((budget?.items ?? []).map((i) => i.amount));
    return {
      budget,
      rab,
      locked: !!budget?.approvedAt,
      totals: {
        rab: totalRab, rap: totalRap, selisih: totalRab.minus(totalRap),
        bkpuPct: totalRab.gt(0) && totalRap.gt(0) ? totalRap.div(totalRab).mul(100).toDecimalPlaces(2).toNumber() : null,
        contractValue: p.contractValue,
      },
    };
  }

  private async draftRap(u: AuthUser, id: string) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    let b = await this.prisma.budget.findFirst({ where: { tenantId: u.tenantId, projectId: id, isBaseline: true }, orderBy: { revision: 'desc' } });
    if (!b) b = await this.prisma.budget.create({ data: { tenantId: u.tenantId, projectId: id, name: 'RAP', isBaseline: true } });
    if (b.approvedAt) throw new BusinessError('RAP sudah ditetapkan. Perubahan setelah penetapan dilakukan lewat Variation order.', 'RAP_LOCKED');
    return b;
  }

  async saveRap(u: AuthUser, id: string, dto: RapDto) {
    const b = await this.draftRap(u, id);
    const rabIds = new Set((await this.prisma.bqItem.findMany({ where: { tenantId: u.tenantId, projectId: id }, select: { id: true } })).map((r) => r.id));
    const items = dto.items.map((i, k) => {
      if (i.bqItemId && !rabIds.has(i.bqItemId)) throw new BusinessError(`Baris ${k + 1}: acuan RAB tidak ditemukan`);
      if (!i.description.trim()) throw new BusinessError(`Baris ${k + 1}: uraian wajib diisi`);
      const quantity = D(i.quantity);
      const unitRate = D(i.unitRate);
      if (quantity.lt(0) || unitRate.lt(0)) throw new BusinessError(`Baris ${k + 1}: volume dan harga satuan tidak boleh negatif`);
      return {
        tenantId: u.tenantId, budgetId: b.id, bqItemId: i.bqItemId || null, sortOrder: k, section: i.section?.trim() || null, code: i.code?.trim() || null,
        wbsCode: i.section?.trim() || null, category: i.category, description: i.description.trim(), unit: i.unit?.trim() || null,
        quantity: quantity.toDecimalPlaces(6), unitRate: unitRate.toDecimalPlaces(6), amount: round2(quantity.mul(unitRate)),
      };
    });
    await this.prisma.$transaction([
      this.prisma.budgetItem.deleteMany({ where: { budgetId: b.id } }),
      this.prisma.budgetItem.createMany({ data: items }),
    ]);
    await this.audit.log(u, 'UPDATE_RAP', 'Project', id, { items: items.length, total: sumD(items.map((i) => i.amount)).toString() });
    return this.rap(u, id);
  }

  async approveRap(u: AuthUser, id: string) {
    const b = await this.draftRap(u, id);
    const count = await this.prisma.budgetItem.count({ where: { budgetId: b.id } });
    if (!count) throw new BusinessError('RAP masih kosong. Isi dan simpan RAP terlebih dahulu.');
    // BK/PU penetapan = BK/PU awal saat RAP ditetapkan: total RAP ÷ total RAB (tanpa RAB: ÷ nilai kontrak)
    const p = notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    const [rap, rab] = await Promise.all([
      this.prisma.budgetItem.aggregate({ where: { budgetId: b.id }, _sum: { amount: true } }),
      this.prisma.bqItem.aggregate({ where: { tenantId: u.tenantId, projectId: id }, _sum: { amount: true } }),
    ]);
    const pu = D(rab._sum.amount).gt(0) ? D(rab._sum.amount) : p.contractValue;
    const bkpu = pu.gt(0) ? D(rap._sum.amount).div(pu).mul(100).toDecimalPlaces(2) : null;
    if (bkpu && bkpu.gt(99999)) throw new BusinessError('BK/PU RAP tidak wajar. Periksa nilai RAP dan RAB.');
    await this.prisma.$transaction([
      this.prisma.budget.update({ where: { id: b.id }, data: { approvedAt: new Date() } }),
      this.prisma.project.update({ where: { id }, data: { bkpuPenetapanPct: bkpu } }),
    ]);
    await this.audit.log(u, 'APPROVE_RAP', 'Project', id, { budgetId: b.id, bkpuPenetapanPct: bkpu?.toString() ?? null });
    return this.rap(u, id);
  }

  async costs(u: AuthUser, id: string) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    return this.prisma.projectCost.findMany({ where: { tenantId: u.tenantId, projectId: id }, orderBy: { costDate: 'desc' } });
  }

  async create(u: AuthUser, dto: ProjectDto) {
    return this.prisma.$transaction(async (tx) => {
      const company = notFound(await tx.company.findFirst({ where: { tenantId: u.tenantId } }), 'Perusahaan');
      let ownerName: string | undefined;
      if (dto.customerId) {
        const c = notFound(await tx.customer.findFirst({ where: { id: dto.customerId, tenantId: u.tenantId } }), 'Customer');
        ownerName = c.name;
      }
      const code = await this.seq.next(tx, u.tenantId, 'PRJ');
      const p = await tx.project.create({
        data: {
          tenantId: u.tenantId, companyId: company.id, customerId: dto.customerId || null, ownerName,
          code, name: dto.name, location: dto.location,
          managerName: dto.managerName, contractValue: D(dto.contractValue),
          retentionPct: dto.retentionPct ? D(dto.retentionPct) : undefined,
          startDate: dto.startDate ? new Date(dto.startDate) : null, endDate: dto.endDate ? new Date(dto.endDate) : null,
          budgets: { create: { tenantId: u.tenantId, name: `RAP ${code}`, isBaseline: true } },
        },
      });
      await this.audit.log(u, 'CREATE', 'Project', p.id, { code: p.code }, tx);
      return p;
    });
  }

  async update(u: AuthUser, id: string, dto: ProjectPatchDto) {
    const p = notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    if (dto.status && dto.status !== p.status && !TRANSITIONS[p.status].includes(dto.status)) {
      throw new BusinessError(`Status proyek tidak bisa berubah dari ${p.status} ke ${dto.status}`);
    }
    let coverFileId: string | null | undefined;
    if (dto.coverFileId !== undefined) {
      if (dto.coverFileId === '') coverFileId = null;
      else {
        const f = notFound(await this.prisma.fileObject.findFirst({ where: { id: dto.coverFileId, tenantId: u.tenantId, entityType: 'Project', entityId: id } }), 'Foto');
        if (!f.mimeType.startsWith('image/')) throw new BusinessError('Foto proyek harus berupa gambar (JPG, PNG, WEBP)');
        coverFileId = f.id;
      }
    }
    const res = await this.prisma.project.update({
      where: { id },
      data: {
        status: dto.status, managerName: dto.managerName, location: dto.location,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined, endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        coverFileId,
        coverTitle: dto.coverTitle === undefined ? (coverFileId === null ? null : undefined) : dto.coverTitle.trim() || null,
      },
    });
    await this.audit.log(u, dto.status && dto.status !== p.status ? `STATUS_${dto.status}` : 'UPDATE', 'Project', id, { before: { status: p.status }, after: dto });
    return res;
  }

  async addProgress(u: AuthUser, id: string, dto: ProgressDto) {
    const p = notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    if (!['ACTIVE', 'COMPLETION'].includes(p.status)) throw new BusinessError('Progres hanya dapat dicatat untuk proyek aktif');
    const actual = D(dto.actualPct), planned = D(dto.plannedPct);
    if (actual.lt(0) || actual.gt(100) || planned.lt(0) || planned.gt(100)) throw new BusinessError('Persentase harus 0–100');
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.progressEntry.create({
        data: { tenantId: u.tenantId, projectId: id, reportDate: new Date(dto.reportDate), plannedPct: planned, actualPct: actual, notes: dto.notes, createdBy: u.userId },
      });
      await tx.project.update({ where: { id }, data: { progressPct: actual, plannedPct: planned } });
      await this.audit.log(u, 'PROGRESS', 'Project', id, { actual: dto.actualPct, planned: dto.plannedPct }, tx);
      return e;
    });
  }

  async addDailyReport(u: AuthUser, id: string, dto: DailyReportDto) {
    notFound(await this.prisma.project.findFirst({ where: { id, tenantId: u.tenantId } }), 'Proyek');
    const r = await this.prisma.dailyReport.create({
      data: { tenantId: u.tenantId, projectId: id, reportDate: new Date(dto.reportDate), weather: dto.weather, manpower: dto.manpower, activities: dto.activities, issues: dto.issues, createdBy: u.userId },
    });
    await this.audit.log(u, 'DAILY_REPORT', 'Project', id, { reportId: r.id });
    return r;
  }

  async costPortfolio(u: AuthUser) {
    const rows = await this.list(u);
    return rows.filter((p) => !['CANCELLED'].includes(p.status));
  }
}

@ApiTags('Projects & Cost Control')
@Controller()
export class ProjectsController {
  constructor(private svc: ProjectsService) {}

  @Get('projects') @Perm('project:read', 'cost:read', 'procurement:read', 'finance:read')
  list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }
  @Post('projects') @Perm('project:write')
  create(@CurrentUser() u: AuthUser, @Body() dto: ProjectDto) { return this.svc.create(u, dto); }
  @Get('projects/:id') @Perm('project:read', 'cost:read')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }
  @Patch('projects/:id') @Perm('project:write')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ProjectPatchDto) { return this.svc.update(u, id, dto); }
  @Get('projects/:id/bq/items') @Perm('project:read', 'tender:read')
  bq(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.bq(u, id); }
  @Get('projects/:id/rap') @Perm('project:read', 'cost:read')
  rap(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.rap(u, id); }
  @Put('projects/:id/rap') @Perm('project:write')
  saveRap(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RapDto) { return this.svc.saveRap(u, id, dto); }
  @Post('projects/:id/rap/approve') @Perm('project:write')
  approveRap(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.approveRap(u, id); }
  @Get('projects/:id/budget') @Perm('project:read', 'cost:read')
  budget(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.budget(u, id); }
  @Get('projects/:id/costs') @Perm('cost:read', 'project:read')
  costs(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.costs(u, id); }
  @Post('projects/:id/progress') @Perm('project:write')
  progress(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ProgressDto) { return this.svc.addProgress(u, id, dto); }
  @Post('projects/:id/daily-reports') @Perm('project:write')
  daily(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DailyReportDto) { return this.svc.addDailyReport(u, id, dto); }
  @Get('reports/cost-control') @Perm('cost:read')
  portfolio(@CurrentUser() u: AuthUser) { return this.svc.costPortfolio(u); }
}

@Module({ controllers: [ProjectsController], providers: [ProjectsService, CostService], exports: [CostService, ProjectsService] })
export class ProjectsModule {}
