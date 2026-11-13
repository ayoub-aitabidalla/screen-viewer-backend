import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminGuard } from "../auth/admin.guard";
import { UsersModule } from "../users/users.module";
import { Camera } from "./camera.entity";
import { CamerasController } from "./cameras.controller";
import { CamerasService } from "./cameras.service";

@Module({
  imports: [TypeOrmModule.forFeature([Camera]), UsersModule],
  controllers: [CamerasController],
  providers: [CamerasService, AdminGuard],
})
export class CamerasModule {}
