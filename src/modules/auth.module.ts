import { menusFor } from '../common/access';
import { Body, Controller, Get, Injectable, Module, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { AuditService } from '../common/common.service';
import { SOURCE, SuperAppsService } from './superapps.module';

class LoginDto {
  /** Kode perusahaan; boleh kosong bila server memakai satu perusahaan (DEFAULT_TENANT / SUPERAPPS_TENANT) */
  @IsOptional() @IsString() tenant?: string;
  /** Email atau username */
  @IsString() @MinLength(2) email!: string;
  @IsString() @MinLength(1) password!: string;
}
class RefreshDto {
  @IsString() refreshToken!: string;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private audit: AuditService, private superapps: SuperAppsService) {}

  get superappsEnabled() {
    return this.superapps.enabled;
  }
  get fixedTenant() {
    return (process.env.DEFAULT_TENANT || process.env.SUPERAPPS_TENANT || '').trim().toLowerCase() || null;
  }

  private async buildSession(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { role: true } }, tenant: true },
    });
    const roles = [...new Set(user.memberships.map((m) => m.role.name))];
    const perms = [...new Set(user.memberships.flatMap((m) => (m.role.permissions as string[]) ?? []))];
    const menus = menusFor(user.memberships.map((m) => m.role));

    const accessToken = this.jwt.sign(
      { sub: user.id, tid: user.tenantId, name: user.name, email: user.email, roles, perms },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as any },
    );

    // Rotating refresh token — disimpan dalam bentuk hash
    const refreshToken = randomBytes(48).toString('base64url');
    const days = Number(process.env.REFRESH_TTL_DAYS ?? 7);
    await this.prisma.refreshToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + days * 86400_000),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        title: user.title,
        roles,
        perms,
        menus,
        tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
      },
    };
  }

  async login(dto: LoginDto) {
    const slug = (dto.tenant?.trim() || this.fixedTenant || '').toLowerCase();
    const tenant = slug ? await this.prisma.tenant.findUnique({ where: { slug } }) : null;
    const invalid = new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Perusahaan, email/username atau password salah' });
    if (!tenant || tenant.status !== 'ACTIVE') throw invalid;
    const identifier = dto.email.trim().toLowerCase();

    // 1) Akun SuperApps (perusahaan yang terhubung)
    if (this.superapps.enabled && tenant.slug === this.superapps.tenantSlug) {
      const candidates = await this.superapps.findByIdentifier(identifier);
      if (candidates.length) {
        const su = await this.superapps.verify(candidates, dto.password);
        if (!su) throw invalid;
        const e = this.superapps.eligibility(su);
        if (!e.ok) throw new UnauthorizedException({ code: e.code, message: e.reason });
        const { user } = await this.superapps.provision(tenant.id, su, e.roles);
        if (!user.isActive) throw new UnauthorizedException({ code: 'USER_DISABLED', message: 'Akun Anda dinonaktifkan di ERP. Hubungi administrator.' });
        await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        await this.audit.log({ tenantId: tenant.id, userId: user.id, name: user.name }, 'LOGIN', 'User', user.id, { source: SOURCE });
        return this.buildSession(user.id);
      }
      // tidak ada di SuperApps → coba akun lokal ERP (mis. admin cadangan)
    }

    // 2) Akun lokal ERP
    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: identifier } },
    });
    if (!user || !user.isActive || !user.passwordHash || user.externalSource) throw invalid;
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) throw invalid;

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ tenantId: tenant.id, userId: user.id, name: user.name }, 'LOGIN', 'User', user.id);
    return this.buildSession(user.id);
  }

  async refresh(token: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH', message: 'Sesi berakhir, silakan login ulang' });
    }
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    const u = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { isActive: true } });
    if (!u?.isActive) throw new UnauthorizedException({ code: 'INVALID_REFRESH', message: 'Sesi berakhir, silakan login ulang' });
    return this.buildSession(row.userId);
  }

  async logout(token: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }
}

@ApiTags('Auth')
@Controller()
export class AuthController {
  constructor(private auth: AuthService, private prisma: PrismaService) {}

  @Public()
  @Throttle({ default: { limit: Number(process.env.LOGIN_RATE_LIMIT ?? 10), ttl: 60_000 } })
  @Post('auth/login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  /** Info login untuk aplikasi: perusahaan tetap & sumber akun */
  @Public()
  @Get('auth/config')
  config() {
    // SHOW_DEMO=true menampilkan tombol akun demo di halaman login (default: false)
    return { tenant: this.auth.fixedTenant, superapps: this.auth.superappsEnabled, demo: process.env.SHOW_DEMO === 'true' };
  }

  @Public()
  @Post('auth/refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('auth/logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('tenant')
  tenant(@CurrentUser() user: AuthUser) {
    return this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { companies: true },
    });
  }
}

@Module({ controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
