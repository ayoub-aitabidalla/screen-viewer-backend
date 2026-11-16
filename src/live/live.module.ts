import { Module } from "@nestjs/common";
import { GatewaysModule } from "../gateways/gateways.module";
import { LiveController } from "./live.controller";
import { LiveService } from "./live.service";

@Module({
  imports: [GatewaysModule],
  controllers: [LiveController],
  providers: [LiveService],
})
export class LiveModule {}
