import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../auth/admin.guard";
import { TenantId } from "../auth/tenant.decorator";
import { CreateGatewayDto, UpdateGatewayDto } from "./gateway.dto";
import { GatewaysService } from "./gateways.service";

/** Passerelles vidéo (MediaMTX + go2rtc) du client connecté. Lecture : tout utilisateur du client ; écriture : admin. */
@Controller("gateways")
export class GatewaysController {
  constructor(private readonly gateways: GatewaysService) {}

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
    return this.gateways.remove(t, id);
  }
}
