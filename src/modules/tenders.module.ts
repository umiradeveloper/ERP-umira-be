import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumberString, IsOptional, IsString, ValidateNested, ValidateIf } from 'class-validator';
import { CostCategory, Prisma, Tender, TenderItem } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, D, notFound, round2, SequenceService, sumD } from '../common/common.service';
import { BusinessError } from '../common/http';

const CATS = ['MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'OTHER'];

class TenderDto {
  @IsString() title!: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsDateString() deadline?: string;
  @IsOptional() @IsNumberString() overheadPct?: string;
  /** Overhead nominal (Rp); "" = kembali memakai persentase */
  @IsOptional() @ValidateIf((o) => o.overheadAmount !== '') @IsNumberString() overheadAmount?: string;
  @IsOptional() @IsNumberString() contingencyPct?: string;
  @IsOptional() @IsNumberString() profitPct?: string;
  @IsOptional() @IsNumberString() taxPct?: string;
  @IsOptional() @IsString() notes?: string;
}
class ItemDto {
  @IsString() section!: string;
  @IsString() code!: string;
  @IsString() description!: string;
  @IsOptional() @IsString() unit?: string;
  @IsIn(CATS) category!: CostCategory;
  @IsOptional() @IsString() costCode?: string;
  @IsNumberString() quantity!: string;
  @IsNumberString() unitCost!: string;
}
class ItemsDto {
  @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[];
}
class DecisionDto {
  @IsIn(['WON', 'LOST', 'CANCELLED']) decision!: 'WON' | 'LOST' | 'CANCELLED';
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsString() managerName?: string;
}

/** Kalkulasi estimator (PRD §5.3): direct cost → overhead → contingency → profit → pajak */
export function calcTender(t: Pick<Tender, 'overheadPct' | 'contingencyPct' | 'profitPct' | 'taxPct'> & { overheadAmount?: Prisma.Decimal | null }, items: Pick<TenderItem, 'amount' | 'category'>[]) {
  const directCost = sumD(items.map((i) => i.amount));
  const byCategory: Record<string, Prisma.Decimal> = {};
  for (const i of items) byCategory[i.category] = (byCategory[i.category] ?? D(0)).plus(i.amount);
  // Overhead: nominal (bila diisi) atau persentase dari biaya langsung
  const overhead = t.overheadAmount != null ? round2(D(t.overheadAmount)) : round2(directCost.mul(t.overheadPct).div(100));
  const overheadPctEff = directCost.gt(0) ? overhead.div(directCost).mul(100).toDecimalPlaces(4).toNumber() : 0;
  const contingency = round2(directCost.mul(t.contingencyPct).div(100));
  const costTotal = directCost.plus(overhead).plus(contingency);
  const profit = round2(costTotal.mul(t.profitPct).div(100));
  const subtotal = costTotal.plus(profit);
  const tax = round2(subtotal.mul(t.taxPct).div(100));
  return { directCost, byCategory, overhead, overheadPct: overheadPctEff, contingency, profit, subtotal, tax, grandTotal: subtotal.plus(tax) };
}

@Injectable()
export class TendersService {
  constructor(private prisma: PrismaService, private seq: SequenceService, private audit: AuditService) {}

  async list(u: AuthUser) {
    const rows = await this.prisma.tender.findMany({
      where: { tenantId: u.tenantId },
      include: { customer: { select: { name: true } }, items: { select: { amount: true, category: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(({ items, ...t }) => ({ ...t, itemCount: items.length, totals: calcTender(t, items) }));
  }

  async get(u: AuthUser, id: string) {
    const t = notFound(
      await this.prisma.tender.findFirst({
        where: { id, tenantId: u.tenantId },
        include: { customer: true, items: { orderBy: { sortOrder: 'asc' } } },
      }),
      'Tender',
    );
    return { ...t, totals: calcTender(t, t.items) };
  }

  async create(u: AuthUser, dto: TenderDto) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.customerId) notFound(await tx.customer.findFirst({ where: { id: dto.customerId, tenantId: u.tenantId } }), 'Customer');
      const t = await tx.tender.create({
        data: {
          tenantId: u.tenantId,
          number: await this.seq.next(tx, u.tenantId, 'TND'),
          title: dto.title,
          customerId: dto.customerId || null,
          location: dto.location,
          deadline: dto.deadline ? new Date(dto.deadline) : null,
          notes: dto.notes,
          createdBy: u.userId,
          ...(dto.overheadPct ? { overheadPct: D(dto.overheadPct) } : {}),
        ...(dto.overheadAmount ? { overheadAmount: this.nonNegative(dto.overheadAmount, 'Overhead') } : {}),
          ...(dto.contingencyPct ? { contingencyPct: D(dto.contingencyPct) } : {}),
          ...(dto.profitPct ? { profitPct: D(dto.profitPct) } : {}),
          ...(dto.taxPct ? { taxPct: D(dto.taxPct) } : {}),
        },
      });
      await this.audit.log(u, 'CREATE', 'Tender', t.id, { number: t.number }, tx);
      return t;
    });
  }

  private assertEditable(t: Tender) {
    if (!['DRAFT', 'REVIEW'].includes(t.status)) throw new BusinessError('Tender yang sudah diajukan tidak dapat diubah');
  }

  private nonNegative(v: string, label: string) {
    const n = D(v);
    if (n.lt(0)) throw new BusinessError(`${label} tidak boleh negatif`);
    return round2(n);
  }

  async update(u: AuthUser, id: string, dto: TenderDto) {
    const t = notFound(await this.prisma.tender.findFirst({ where: { id, tenantId: u.tenantId } }), 'Tender');
    this.assertEditable(t);
    const res = await this.prisma.tender.update({
      where: { id },
      data: {
        title: dto.title,
        customerId: dto.customerId || null,
        location: dto.location,
        deadline: dto.deadline === undefined ? undefined : dto.deadline ? new Date(dto.deadline) : null,
        notes: dto.notes,
        overheadPct: dto.overheadPct !== undefined && dto.overheadPct !== '' ? D(dto.overheadPct) : undefined,
        overheadAmount: dto.overheadAmount === undefined ? undefined : dto.overheadAmount === '' ? null : this.nonNegative(dto.overheadAmount, 'Overhead'),
        contingencyPct: dto.contingencyPct !== undefined && dto.contingencyPct !== '' ? D(dto.contingencyPct) : undefined,
        profitPct: dto.profitPct !== undefined && dto.profitPct !== '' ? D(dto.profitPct) : undefined,
        taxPct: dto.taxPct !== undefined && dto.taxPct !== '' ? D(dto.taxPct) : undefined,
      },
    });
    await this.audit.log(u, 'UPDATE', 'Tender', id, dto as any);
    return res;
  }

  /** Simpan seluruh BQ tender (replace) */
  async saveItems(u: AuthUser, id: string, dto: ItemsDto) {
    const t = notFound(await this.prisma.tender.findFirst({ where: { id, tenantId: u.tenantId } }), 'Tender');
    this.assertEditable(t);
    await this.prisma.$transaction(async (tx) => {
      await tx.tenderItem.deleteMany({ where: { tenderId: id, tenantId: u.tenantId } });
      await tx.tenderItem.createMany({
        data: dto.items.map((i, idx) => ({
          tenantId: u.tenantId,
          tenderId: id,
          sortOrder: idx,
          section: i.section,
          code: i.code,
          description: i.description,
          unit: i.unit,
          category: i.category,
          costCode: i.costCode,
          quantity: D(i.quantity),
          unitCost: D(i.unitCost),
          amount: round2(D(i.quantity).mul(D(i.unitCost))),
        })),
      });
      await this.audit.log(u, 'UPDATE_BQ', 'Tender', id, { items: dto.items.length }, tx);
    });
    return this.get(u, id);
  }

  async transition(u: AuthUser, id: string, to: 'REVIEW' | 'SUBMITTED') {
    const t = notFound(await this.prisma.tender.findFirst({ where: { id, tenantId: u.tenantId }, include: { items: true } }), 'Tender');
    const allowed: Record<string, string[]> = { REVIEW: ['DRAFT'], SUBMITTED: ['REVIEW', 'DRAFT'] };
    if (!allowed[to].includes(t.status)) throw new BusinessError(`Tender berstatus ${t.status} tidak bisa diubah ke ${to}`);
    if (t.items.length === 0) throw new BusinessError('BQ masih kosong');
    const res = await this.prisma.tender.update({ where: { id }, data: { status: to } });
    await this.audit.log(u, to, 'Tender', id);
    return res;
  }

  /**
   * Keputusan tender. Jika MENANG: snapshot BQ dikonversi ke proyek (harga jual) dan
   * budget baseline (harga biaya). Data tender tidak diubah (PRD §5.3).
   */
  async decision(u: AuthUser, id: string, dto: DecisionDto) {
    return this.prisma.$transaction(async (tx) => {
      const t = notFound(
        await tx.tender.findFirst({ where: { id, tenantId: u.tenantId }, include: { items: { orderBy: { sortOrder: 'asc' } }, customer: true } }),
        'Tender',
      );
      if (t.status !== 'SUBMITTED') throw new BusinessError('Keputusan hanya untuk tender yang sudah diajukan');

      if (dto.decision !== 'WON') {
        await tx.tender.update({ where: { id }, data: { status: dto.decision } });
        await this.audit.log(u, dto.decision, 'Tender', id, {}, tx);
        return { status: dto.decision };
      }

      const totals = calcTender(t, t.items);
      const factor = totals.directCost.gt(0) ? totals.subtotal.div(totals.directCost) : D(1);
      const company = notFound(await tx.company.findFirst({ where: { tenantId: u.tenantId } }), 'Perusahaan');

      const bq = t.items.map((i) => {
        const unitPrice = i.unitCost.mul(factor).toDecimalPlaces(6);
        return { i, unitPrice, amount: round2(unitPrice.mul(i.quantity)) };
      });
      const contractValue = sumD(bq.map((b) => b.amount));

      const project = await tx.project.create({
        data: {
          tenantId: u.tenantId,
          companyId: company.id,
          customerId: t.customerId,
          tenderId: t.id,
          code: await this.seq.next(tx, u.tenantId, 'PRJ'),
          name: t.title,
          ownerName: t.customer?.name,
          location: t.location,
          managerName: dto.managerName,
          contractValue,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          status: 'SETUP',
          bqItems: {
            create: bq.map(({ i, unitPrice, amount }) => ({
              tenantId: u.tenantId, sortOrder: i.sortOrder, section: i.section, code: i.code, description: i.description,
              unit: i.unit, category: i.category, costCode: i.costCode, quantity: i.quantity, unitPrice, amount, estUnitCost: i.unitCost,
            })),
          },
        },
      });
      // RAP disusun setelah menang tender: draf RAP mengikuti struktur RAB (acuan),
      // volume = volume RAB, harga satuan = estimasi biaya tender. Diperiksa & ditetapkan di tab RAP proyek.
      const rab = await tx.bqItem.findMany({ where: { projectId: project.id }, orderBy: { sortOrder: 'asc' } });
      const indirect = [
        ...(totals.overhead.gt(0) ? [{ code: 'BTL.1', description: 'Overhead proyek', category: 'OVERHEAD' as CostCategory, amount: totals.overhead }] : []),
        ...(totals.contingency.gt(0) ? [{ code: 'BTL.2', description: 'Contingency', category: 'OTHER' as CostCategory, amount: totals.contingency }] : []),
      ];
      await tx.budget.create({
        data: {
          tenantId: u.tenantId, projectId: project.id, name: `RAP ${project.code}`, isBaseline: true, revision: 1,
          items: {
            create: [
              ...rab.map((r, k) => ({
                tenantId: u.tenantId, bqItemId: r.id, sortOrder: k, section: r.section, code: r.code, wbsCode: r.section, costCode: r.costCode,
                category: r.category, description: r.description, unit: r.unit, quantity: r.quantity, unitRate: r.estUnitCost,
                amount: round2(r.quantity.mul(r.estUnitCost)),
              })),
              ...indirect.map((x, k) => ({
                tenantId: u.tenantId, sortOrder: rab.length + k, section: 'Biaya tidak langsung', code: x.code, wbsCode: 'Biaya tidak langsung',
                category: x.category, description: x.description, unit: 'ls', quantity: D(1), unitRate: x.amount, amount: x.amount,
              })),
            ],
          },
        },
      });
      await tx.tender.update({ where: { id }, data: { status: 'WON', projectId: project.id } });
      await this.audit.log(u, 'WON', 'Tender', id, { projectId: project.id, projectCode: project.code }, tx);
      await this.audit.log(u, 'CREATE_FROM_TENDER', 'Project', project.id, { tender: t.number }, tx);
      return { status: 'WON', projectId: project.id };
    });
  }
}

@ApiTags('Tender & BQ')
@Controller('tenders')
export class TendersController {
  constructor(private svc: TendersService) {}

  @Get() @Perm('tender:read')
  list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }
  @Get(':id') @Perm('tender:read')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.get(u, id); }
  @Post() @Perm('tender:write')
  create(@CurrentUser() u: AuthUser, @Body() dto: TenderDto) { return this.svc.create(u, dto); }
  @Patch(':id') @Perm('tender:write')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: TenderDto) { return this.svc.update(u, id, dto); }
  @Put(':id/items') @Perm('tender:write')
  items(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ItemsDto) { return this.svc.saveItems(u, id, dto); }
  @Post(':id/review') @Perm('tender:write')
  review(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.transition(u, id, 'REVIEW'); }
  @Post(':id/submit') @Perm('tender:write')
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.transition(u, id, 'SUBMITTED'); }
  @Post(':id/decision') @Perm('tender:write')
  decision(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DecisionDto) { return this.svc.decision(u, id, dto); }
}

@Module({ controllers: [TendersController], providers: [TendersService] })
export class TendersModule {}
