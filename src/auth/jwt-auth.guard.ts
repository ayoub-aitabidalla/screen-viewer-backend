import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { AUTH_COOKIE, IS_PUBLIC } from "./auth.constants";

export interface JwtPayload {
  sub: string;
  username: string;
  tenantId: string;
}

/** Guard global : toute route exige un JWT valide (cookie ou en-tête Bearer), sauf celles marquées @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const header = req.headers.authorization;
    const token = req.cookies?.[AUTH_COOKIE] ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
    if (!token) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      // Jeton émis avant le multi-client (sans tenantId) : reconnexion obligatoire.
      if (!payload.tenantId) throw new Error("tenantId absent");
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
