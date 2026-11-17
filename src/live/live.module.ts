import { Module } from "@nestjs/common";
import { GatewaysModule } from "../gateways/gateways.module";
import { LiveController } from "./live.controller";
import { LiveMseRelay } from "./live-mse.relay";
import { LiveService } from "./live.service";

@Module({
  imports: [GatewaysModule],
  controllers: [LiveController],
  providers: [LiveService, LiveMseRelay],
})
export class LiveModule {}
