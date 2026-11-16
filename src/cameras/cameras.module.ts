import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminGuard } from "../auth/admin.guard";
import { DvrsModule } from "../dvrs/dvrs.module";
import { UsersModule } from "../users/users.module";
import { Camera } from "./camera.entity";
import { CamerasController } from "./cameras.controller";
import { CamerasService } from "./cameras.service";

@Module({
  imports: [TypeOrmModule.forFeature([Camera]), UsersModule, DvrsModule],
  controllers: [CamerasController],
  providers: [CamerasService, AdminGuard],
})
export class CamerasModule {}
