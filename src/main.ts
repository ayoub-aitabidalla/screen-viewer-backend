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
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`ScreenBackend : http://localhost:${port}/api`);
}
bootstrap();
