import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminGuard } from "../auth/admin.guard";
import { Camera } from "../cameras/camera.entity";
import { GatewaysModule } from "../gateways/gateways.module";
import { UsersModule } from "../users/users.module";
import { Dvr } from "./dvr.entity";
import { DvrsController } from "./dvrs.controller";
import { DvrsService } from "./dvrs.service";

@Module({
  imports: [TypeOrmModule.forFeature([Dvr, Camera]), UsersModule, GatewaysModule],
  controllers: [DvrsController],
  providers: [DvrsService, AdminGuard],
  exports: [DvrsService],
})
export class DvrsModule {}
