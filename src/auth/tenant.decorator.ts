import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { JwtPayload } from "./jwt-auth.guard";

/** Client (tenant) de l'utilisateur connecté, tiré du JWT. Toute requête métier doit filtrer par cette valeur. */
export const TenantId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const t = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>().user?.tenantId;
  if (!t) throw new UnauthorizedException();
  return t;
});
