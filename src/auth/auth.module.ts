import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule, type JwtModuleOptions } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";
import { UsersModule } from "../users/users.module";
import { AuthThrottlerGuard } from "./auth-throttler.guard";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";

@Module({
  imports: [
    UsersModule,
    // Compteurs utilisés par AuthThrottlerGuard (connexion / inscription uniquement). Stockage en mémoire :
    // à remplacer par Redis si plusieurs instances du backend tournent derrière un répartiteur.
    ThrottlerModule.forRoot({
      throttlers: [
        // Par adresse IP : 20 tentatives par minute (une IP qui balaie plusieurs comptes).
        { name: "ip", ttl: 60_000, limit: 20 },
        // Par compte visé : 10 tentatives par 15 min, puis blocage 15 min (un compte attaqué depuis plusieurs IP).
        {
          name: "account",
          ttl: 15 * 60_000,
          limit: 10,
          blockDuration: 15 * 60_000,
          getTracker: (req: Record<string, any>) => {
            const u = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
            return u ? `user:${u}` : `ip:${req.ip}`;
          },
        },
      ],
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (c: ConfigService): JwtModuleOptions => {
        const secret = c.get<string>("JWT_SECRET");
        if (!secret) throw new Error("JWT_SECRET manquant dans .env");
        const expiresIn = (c.get<string>("JWT_EXPIRES_IN") ?? "8h") as NonNullable<JwtModuleOptions["signOptions"]>["expiresIn"];
        return { secret, signOptions: { expiresIn } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthThrottlerGuard, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}
