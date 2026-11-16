import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminGuard } from "../auth/admin.guard";
import { Dvr } from "../dvrs/dvr.entity";
import { UsersModule } from "../users/users.module";
import { Gateway } from "./gateway.entity";
import { GatewaysController } from "./gateways.controller";
import { GatewaysService } from "./gateways.service";

@Module({
  imports: [TypeOrmModule.forFeature([Gateway, Dvr]), UsersModule],
  controllers: [GatewaysController],
  providers: [GatewaysService, AdminGuard],
  exports: [GatewaysService],
})
export class GatewaysModule {}
