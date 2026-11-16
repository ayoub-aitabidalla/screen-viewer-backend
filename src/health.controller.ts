import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/public.decorator";

/** État du serveur, lisible sans session (pied de l'écran de connexion). Ne révèle rien sur les clients. */
@Controller("health")
export class HealthController {
  @Public()
  @Get()
  health() {
    return { ok: true };
  }
}
