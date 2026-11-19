import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import type { NextFunction, Request, Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  serveViewer(app);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`ScreenBackend : http://localhost:${port}/api`);
}
/**
 * Sert le viewer compilé (dossier public/, produit par `npm run build:backend` dans ScreenViewer) depuis le
 * même domaine que /api : cookie de session et WebSocket du direct fonctionnent sans CORS. Utile chez les
 * hébergeurs à une seule application (Cloudways). Absent en développement (Vite) et en Docker (Caddy).
 */
function serveViewer(app: NestExpressApplication) {
  const dir = join(__dirname, "..", "public");
  const index = join(dir, "index.html");
  if (!existsSync(index)) return;
  app.useStaticAssets(dir, { index: false, maxAge: "1h" });
  // Application monopage : toute page hors /api renvoie index.html.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || req.path === "/api" || req.path.startsWith("/api/")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(index);
  });
}

bootstrap();
