import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../auth/admin.guard";
import { TenantId } from "../auth/tenant.decorator";
import { CreateGatewayDto, ProvisionSiteDto, UpdateGatewayDto } from "./gateway.dto";
import { GatewaysService } from "./gateways.service";
import { SiteProvisioningService } from "./site-provisioning.service";

/** Passerelles vidéo (MediaMTX + go2rtc) du client connecté. Lecture : tout utilisateur du client ; écriture : admin. */
@Controller("gateways")
export class GatewaysController {
  constructor(
    private readonly gateways: GatewaysService,
    private readonly sites: SiteProvisioningService,
  ) {}

  /** Création automatique des sites disponible ? (CF_* renseignés sur le serveur) */
  @Get("provisioning")
  provisioning() {
    return this.sites.status();
  }

  /** Crée un site complet chez Cloudflare (tunnel, noms, Access) et sa passerelle déjà remplie. */
  @Post("provision")
  @UseGuards(AdminGuard)
  provision(@TenantId() t: string, @Body() dto: ProvisionSiteDto) {
    return this.sites.provision(t, dto);
  }

  /** Script d'installation et mot de passe ONVIF d'un site créé automatiquement. */
  @Get(":id/install")
  @UseGuards(AdminGuard)
  install(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.sites.install(t, id);
  }

  @Get()
  list(@TenantId() t: string) {
    return this.gateways.list(t);
  }

  @Get(":id/info")
  info(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.gateways.info(t, id);
  }

  @Post()
  @UseGuards(AdminGuard)
  create(@TenantId() t: string, @Body() dto: CreateGatewayDto) {
    return this.gateways.create(t, dto);
  }

  @Patch(":id")
  @UseGuards(AdminGuard)
  update(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateGatewayDto) {
    return this.gateways.update(t, id, dto);
  }

  @Delete(":id")
  @UseGuards(AdminGuard)
  @HttpCode(204)
  remove(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.sites.remove(t, id);
  }
}
