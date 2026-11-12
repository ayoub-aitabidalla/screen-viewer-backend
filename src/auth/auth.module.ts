import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule, type JwtModuleOptions } from "@nestjs/jwt";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";

@Module({
  imports: [
    UsersModule,
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
  providers: [AuthService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}
