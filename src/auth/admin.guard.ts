import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { UsersService } from "../users/users.service";
import type { JwtPayload } from "./jwt-auth.guard";

/** Réserve une route aux comptes de rôle "admin" (à placer après le guard JWT global). */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const user = req.user ? await this.users.findById(req.user.sub) : null;
    // Rôle et client relus en base : un compte rétrogradé ou déplacé perd ses droits sans attendre l'expiration du JWT.
    if (user?.role !== "admin" || user.tenantId !== req.user?.tenantId)
      throw new ForbiddenException({ message: "Réservé aux administrateurs du client", code: null });
    return true;
  }
}
