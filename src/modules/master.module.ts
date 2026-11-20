import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { PERMISSION_MODULES, VALID_PERMISSIONS } from '../common/access';
import { SuperAppsModule, SuperAppsService } from './superapps.module';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Perm } from '../common/auth';
import { AuditService, notFound } from '../common/common.service';
import { BusinessError } from '../common/http';

class PartyDto {
  @Matches(/^[A-Z0-9-]{2,20}$/, { message: 'Kode hanya huruf besar, angka dan tanda minus (2-20)' }) code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() npwp?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() address?: string;
}
class SupplierDto {
  @Matches(/^[A-Z0-9-]{2,20}$/, { message: 'Kode hanya huruf besar, angka dan tanda minus (2-20)' }) code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() taxNumber?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsInt() @Min(0) paymentTerm?: number;
}
class UserDto {
  @IsEmail() email!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() title?: string;
  @IsString() @MinLength(8) password!: string;
  @IsArray() @ArrayMinSize(1) roleIds!: string[];
}
class RoleDto {
  @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @IsOptional() @IsString() @MaxLength(190) description?: string;
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) permissions!: string[];
  /** null = semua menu sesuai permission */
  @IsOptional() @ValidateIf((o) => o.menus !== null) @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) menus?: string[] | null;
}
class UserPatchDto {
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() roleIds?: string[];
}

@Injectable()
export class MasterService {
  constructor(private prisma: PrismaService, private audit: AuditService, private superapps: SuperAppsService) {}

  customers(u: AuthUser, search?: string) {
    return this.prisma.customer.findMany({
      where: { tenantId: u.tenantId, deletedAt: null, ...(search ? { name: { contains: search } } : {}) },
      orderBy: { name: 'asc' },
    });
  }
  async createCustomer(u: AuthUser, dto: PartyDto) {
    const c = await this.prisma.customer.create({ data: { tenantId: u.tenantId, ...dto } });
    await this.audit.log(u, 'CREATE', 'Customer', c.id, { code: c.code });
    return c;
  }
  async updateCustomer(u: AuthUser, id: string, dto: Partial<PartyDto>) {
    notFound(await this.prisma.customer.findFirst({ where: { id, tenantId: u.tenantId } }), 'Customer');
    const c = await this.prisma.customer.update({ where: { id }, data: dto });
    await this.audit.log(u, 'UPDATE', 'Customer', id, dto as any);
    return c;
  }
  async deleteCustomer(u: AuthUser, id: string) {
    notFound(await this.prisma.customer.findFirst({ where: { id, tenantId: u.tenantId } }), 'Customer');
    await this.prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } }); // soft delete
    await this.audit.log(u, 'DELETE', 'Customer', id);
    return { ok: true };
  }

  suppliers(u: AuthUser, search?: string) {
    return this.prisma.supplier.findMany({
      where: { tenantId: u.tenantId, deletedAt: null, ...(search ? { name: { contains: search } } : {}) },
      orderBy: { name: 'asc' },
    });
  }
  private manualVendorGuard() {
    if (process.env.VENDOR_MANUAL_INPUT === 'false') throw new BusinessError('Data vendor dikelola dari sistem sumber. Gunakan tombol Sinkron vendor.', 'VENDOR_MANAGED_EXTERNALLY');
  }
  async createSupplier(u: AuthUser, dto: SupplierDto) {
    this.manualVendorGuard();
    const s = await this.prisma.supplier.create({ data: { tenantId: u.tenantId, ...dto } });
    await this.audit.log(u, 'CREATE', 'Supplier', s.id, { code: s.code });
    return s;
  }
  async updateSupplier(u: AuthUser, id: string, dto: Partial<SupplierDto>) {
    this.manualVendorGuard();
    notFound(await this.prisma.supplier.findFirst({ where: { id, tenantId: u.tenantId } }), 'Supplier');
    const s = await this.prisma.supplier.update({ where: { id }, data: dto });
    await this.audit.log(u, 'UPDATE', 'Supplier', id, dto as any);
    return s;
  }
  async deleteSupplier(u: AuthUser, id: string) {
    notFound(await this.prisma.supplier.findFirst({ where: { id, tenantId: u.tenantId } }), 'Supplier');
    await this.prisma.supplier.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log(u, 'DELETE', 'Supplier', id);
    return { ok: true };
  }

  // ── Users & roles ──
  async users(u: AuthUser) {
    const rows = await this.prisma.user.findMany({
      where: { tenantId: u.tenantId },
      include: { memberships: { include: { role: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map(({ passwordHash, memberships, ...r }) => ({
      ...r,
      roles: memberships.map((m) => ({ id: m.role.id, name: m.role.name })),
    }));
  }
  async roles(u: AuthUser) {
    const rows = await this.prisma.role.findMany({ where: { tenantId: u.tenantId }, orderBy: { name: 'asc' }, include: { _count: { select: { memberships: true } } } });
    return rows.map(({ _count, ...r }) => ({ ...r, users: _count.memberships, system: (r.permissions as string[]).includes('*') }));
  }

  accessCatalog() {
    return { modules: PERMISSION_MODULES };
  }

  private cleanRole(dto: RoleDto) {
    const name = dto.name.trim().replace(/\s+/g, ' ');
    const bad = dto.permissions.filter((p) => !VALID_PERMISSIONS.has(p));
    if (bad.length) throw new BusinessError(`Hak akses tidak dikenal: ${bad.join(', ')}`);
    // "kelola" sudah termasuk "lihat" → simpan level tertinggi saja per modul
    const perms = [...new Set(dto.permissions)].filter((p) => !(p.endsWith(':read') && dto.permissions.includes(p.replace(':read', ':write'))));
    const menus = dto.menus === undefined || dto.menus === null ? null : [...new Set(dto.menus.map((m) => m.trim()).filter((m) => /^\/[a-z0-9/_-]*$/i.test(m)))];
    return { name, description: dto.description?.trim() || null, permissions: perms, menus };
  }

  async createRole(u: AuthUser, dto: RoleDto) {
    const d = this.cleanRole(dto);
    if (await this.prisma.role.findFirst({ where: { tenantId: u.tenantId, name: d.name } })) throw new BusinessError(`Role "${d.name}" sudah ada`);
    const r = await this.prisma.role.create({ data: { tenantId: u.tenantId, ...d, menus: d.menus ?? Prisma.DbNull } });
    await this.audit.log(u, 'CREATE', 'Role', r.id, d as any);
    return r;
  }

  async updateRole(u: AuthUser, id: string, dto: RoleDto) {
    const r = notFound(await this.prisma.role.findFirst({ where: { id, tenantId: u.tenantId } }), 'Role');
    const system = (r.permissions as string[]).includes('*');
    const d = this.cleanRole(dto);
    if (d.name !== r.name && (await this.prisma.role.findFirst({ where: { tenantId: u.tenantId, name: d.name, id: { not: id } } }))) throw new BusinessError(`Role "${d.name}" sudah ada`);
    // Role Administrator (akses penuh) tidak bisa dikurangi agar admin tidak terkunci
    const data = system
      ? { name: d.name, description: d.description }
      : { name: d.name, description: d.description, permissions: d.permissions, menus: d.menus ?? Prisma.DbNull };
    const res = await this.prisma.role.update({ where: { id }, data });
    if (d.name !== r.name) await this.superapps.renameErpRole(u.tenantId, r.name, d.name);
    await this.audit.log(u, 'UPDATE', 'Role', id, { before: { name: r.name, permissions: r.permissions, menus: r.menus }, after: d } as any);
    return res;
  }

  async deleteRole(u: AuthUser, id: string) {
    const r = notFound(await this.prisma.role.findFirst({ where: { id, tenantId: u.tenantId }, include: { _count: { select: { memberships: true } } } }), 'Role');
    if ((r.permissions as string[]).includes('*')) throw new BusinessError('Role dengan akses penuh tidak bisa dihapus');
    if (r._count.memberships) throw new BusinessError(`Role masih dipakai ${r._count.memberships} user. Pindahkan user ke role lain dulu.`, 'ROLE_IN_USE');
    if (await this.superapps.isErpRoleMapped(u.tenantId, r.name)) throw new BusinessError('Role masih dipakai di pemetaan SuperApps. Ubah pemetaannya dulu.', 'ROLE_IN_USE');
    await this.prisma.role.delete({ where: { id } });
    await this.audit.log(u, 'DELETE', 'Role', id, { name: r.name });
    return { ok: true };
  }
  private async assertRoles(u: AuthUser, roleIds: string[]) {
    const n = await this.prisma.role.count({ where: { tenantId: u.tenantId, id: { in: roleIds } } });
    if (n !== roleIds.length) throw new BusinessError('Role tidak valid');
  }
  async createUser(u: AuthUser, dto: UserDto) {
    await this.assertRoles(u, dto.roleIds);
    const user = await this.prisma.user.create({
      data: {
        tenantId: u.tenantId,
        email: dto.email.toLowerCase(),
        name: dto.name,
        title: dto.title,
        passwordHash: await bcrypt.hash(dto.password, 10),
        memberships: { create: dto.roleIds.map((roleId) => ({ tenantId: u.tenantId, roleId })) },
      },
    });
    await this.audit.log(u, 'CREATE', 'User', user.id, { email: user.email, roleIds: dto.roleIds });
    return { id: user.id };
  }
  async updateUser(u: AuthUser, id: string, dto: UserPatchDto) {
    const target = notFound(await this.prisma.user.findFirst({ where: { id, tenantId: u.tenantId } }), 'User');
    if (target.externalSource && dto.roleIds) throw new BusinessError('Role user SuperApps mengikuti SuperApps (atur di Role & menu → Pemetaan SuperApps). Di ERP hanya bisa diaktifkan/nonaktifkan.', 'EXTERNAL_USER_ROLES');
    if (id === u.userId && dto.isActive === false) throw new BusinessError('Tidak dapat menonaktifkan akun sendiri');
    await this.prisma.$transaction(async (tx) => {
      if (dto.isActive !== undefined) {
        await tx.user.update({ where: { id }, data: { isActive: dto.isActive } });
        if (!dto.isActive) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      if (dto.roleIds) {
        await this.assertRoles(u, dto.roleIds);
        await tx.membership.deleteMany({ where: { tenantId: u.tenantId, userId: id, projectId: null } });
        await tx.membership.createMany({ data: dto.roleIds.map((roleId) => ({ tenantId: u.tenantId, userId: id, roleId })) });
      }
      await this.audit.log(u, 'UPDATE', 'User', id, dto as any, tx);
    });
    return { ok: true };
  }

  async auditLogs(u: AuthUser, q: { entityType?: string; search?: string }) {
    return this.prisma.auditLog.findMany({
      where: {
        tenantId: u.tenantId,
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.search ? { OR: [{ action: { contains: q.search } }, { actorName: { contains: q.search } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }
}

@ApiTags('Master Data & Admin')
@Controller()
export class MasterController {
  constructor(private svc: MasterService) {}

  @Get('customers') @Perm('master:read', 'tender:read', 'project:read')
  customers(@CurrentUser() u: AuthUser, @Query('search') s?: string) { return this.svc.customers(u, s); }
  @Post('customers') @Perm('master:write')
  createCustomer(@CurrentUser() u: AuthUser, @Body() dto: PartyDto) { return this.svc.createCustomer(u, dto); }
  @Patch('customers/:id') @Perm('master:write')
  updateCustomer(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PartyDto) { return this.svc.updateCustomer(u, id, dto); }
  @Delete('customers/:id') @Perm('master:write')
  deleteCustomer(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.deleteCustomer(u, id); }

  @Get('suppliers') @Perm('master:read', 'procurement:read')
  suppliers(@CurrentUser() u: AuthUser, @Query('search') s?: string) { return this.svc.suppliers(u, s); }
  @Post('suppliers') @Perm('master:write', 'procurement:write')
  createSupplier(@CurrentUser() u: AuthUser, @Body() dto: SupplierDto) { return this.svc.createSupplier(u, dto); }
  @Patch('suppliers/:id') @Perm('master:write', 'procurement:write')
  updateSupplier(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SupplierDto) { return this.svc.updateSupplier(u, id, dto); }
  @Delete('suppliers/:id') @Perm('master:write')
  deleteSupplier(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.deleteSupplier(u, id); }

  @Get('users') @Perm('admin:read')
  users(@CurrentUser() u: AuthUser) { return this.svc.users(u); }
  @Post('users') @Perm('admin:write')
  createUser(@CurrentUser() u: AuthUser, @Body() dto: UserDto) { return this.svc.createUser(u, dto); }
  @Patch('users/:id') @Perm('admin:write')
  updateUser(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UserPatchDto) { return this.svc.updateUser(u, id, dto); }
  @Get('roles') @Perm('admin:read')
  roles(@CurrentUser() u: AuthUser) { return this.svc.roles(u); }
  @Get('roles/catalog') @Perm('admin:read')
  catalog() { return this.svc.accessCatalog(); }
  @Post('roles') @Perm('admin:write')
  createRole(@CurrentUser() u: AuthUser, @Body() dto: RoleDto) { return this.svc.createRole(u, dto); }
  @Patch('roles/:id') @Perm('admin:write')
  updateRole(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RoleDto) { return this.svc.updateRole(u, id, dto); }
  @Delete('roles/:id') @Perm('admin:write')
  deleteRole(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.deleteRole(u, id); }

  @Get('audit-logs') @Perm('audit:read', 'admin:read')
  audit(@CurrentUser() u: AuthUser, @Query('entityType') entityType?: string, @Query('search') search?: string) {
    return this.svc.auditLogs(u, { entityType, search });
  }
}

@Module({ imports: [SuperAppsModule], controllers: [MasterController], providers: [MasterService] })
export class MasterModule {}
