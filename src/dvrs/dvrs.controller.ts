import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../auth/admin.guard";
import { TenantId } from "../auth/tenant.decorator";
import { CreateDvrDto, UpdateDvrDto } from "./dvr.dto";
import { DvrsService } from "./dvrs.service";

/** DVR/NVR du client connecté. Lecture : tout utilisateur du client ; écriture : admin du client. */
@Controller("dvrs")
export class DvrsController {
  constructor(private readonly dvrs: DvrsService) {}

  @Get()
  list(@TenantId() t: string) {
    return this.dvrs.list(t);
  }

  @Get(":id/info")
  info(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.dvrs.info(t, id);
  }

  @Post()
  @UseGuards(AdminGuard)
  create(@TenantId() t: string, @Body() dto: CreateDvrDto) {
    return this.dvrs.create(t, dto);
  }

  @Patch(":id")
  @UseGuards(AdminGuard)
  update(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateDvrDto) {
    return this.dvrs.update(t, id, dto);
  }

  @Delete(":id")
  @UseGuards(AdminGuard)
  @HttpCode(204)
  remove(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.dvrs.remove(t, id);
  }
}
