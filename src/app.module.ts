import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "./auth/auth.module";
import { CamerasModule } from "./cameras/cameras.module";
import { DvrHistoryModule } from "./dvr-history/dvr-history.module";
import { DvrsModule } from "./dvrs/dvrs.module";
import { GatewaysModule } from "./gateways/gateways.module";
import { LiveModule } from "./live/live.module";
import { HealthController } from "./health.controller";
import { dbOptions } from "./database/data-source";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ useFactory: () => dbOptions() }),
    AuthModule,
    GatewaysModule,
    DvrsModule,
    LiveModule,
    DvrHistoryModule,
    CamerasModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
