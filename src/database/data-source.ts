import "reflect-metadata";
import { DataSourceOptions } from "typeorm";
import { Camera } from "../cameras/camera.entity";
import { Dvr } from "../dvrs/dvr.entity";
import { Gateway } from "../gateways/gateway.entity";
import { Tenant } from "../tenants/tenant.entity";
import { User } from "../users/user.entity";

/** Configuration TypeORM partagée par l'application et le seeder (lue depuis .env). */
export function dbOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  return {
    type: "postgres",
    host: env.DB_HOST ?? "127.0.0.1",
    port: Number(env.DB_PORT ?? 5432),
    database: env.DB_NAME ?? "screenviewer",
    username: env.DB_USER ?? "screenviewer",
    password: env.DB_PASSWORD ?? "screenviewer",
    entities: [Tenant, User, Gateway, Dvr, Camera],
    // Schéma synchronisé automatiquement : suffisant pour démarrer, à remplacer par des migrations.
    synchronize: true,
  };
}
