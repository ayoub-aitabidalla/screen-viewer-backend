import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "./auth/auth.module";
import { CamerasModule } from "./cameras/cameras.module";
import { dbOptions } from "./database/data-source";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ useFactory: () => dbOptions() }),
    AuthModule,
    CamerasModule,
  ],
})
export class AppModule {}
