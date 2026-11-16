import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Camera } from "../cameras/camera.entity";
import { Dvr } from "../dvrs/dvr.entity";
import { DvrsModule } from "../dvrs/dvrs.module";
import { DvrHistoryController } from "./dvr-history.controller";
import { DvrHistoryService } from "./dvr-history.service";

@Module({
  imports: [TypeOrmModule.forFeature([Camera, Dvr]), DvrsModule],
  controllers: [DvrHistoryController],
  providers: [DvrHistoryService],
})
export class DvrHistoryModule {}
