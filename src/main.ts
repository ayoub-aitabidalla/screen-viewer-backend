import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Offres WebRTC (WHEP) du mur en direct : corps SDP brut, relayé tel quel à MediaMTX.
  app.useBodyParser("text", { type: "application/sdp", limit: "64kb" });
  // Le viewer appelle /api/... via le proxy Vite : même origine, pas besoin de CORS.
  // Le viewer passe par un proxy local (Vite, ou un reverse proxy en production) : on fait confiance à son
  // en-tête X-Forwarded-For pour connaître la vraie IP du client (limitation des tentatives de connexion).
  // TRUST_PROXY : "loopback" en local (Vite), "uniquelocal" en Docker (Caddy sur le réseau interne).
  app.set("trust proxy", process.env.TRUST_PROXY || "loopback");
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`ScreenBackend : http://localhost:${port}/api`);
}
bootstrap();
