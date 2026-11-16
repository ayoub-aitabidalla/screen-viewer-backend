import { ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler";

/**
 * Limite les tentatives de connexion et d'inscription (contre les essais de mots de passe en masse).
 * Réservé aux routes @Public d'authentification : les autres routes ne sont pas limitées.
 * Les compteurs « ip » et « account » sont définis dans AuthModule (ThrottlerModule.forRoot).
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(_ctx: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const wait = Math.max(1, Math.ceil(detail.timeToBlockExpire || detail.timeToExpire));
    const delay = wait >= 60 ? `${Math.ceil(wait / 60)} min` : `${wait} s`;
    throw new HttpException(
      { message: `Trop de tentatives. Réessayez dans ${delay}.`, code: "tooManyAttempts", retryAfter: wait },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
