import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../auth/admin.guard";
import { TenantId } from "../auth/tenant.decorator";
import { CreateCameraDto, UpdateCameraDto } from "./camera.dto";
import { CamerasService } from "./cameras.service";

/** ?dvrId= facultatif : absent = unique DVR du client. */
const OptionalUuid = new ParseUUIDPipe({ optional: true });

/**
 * Configuration des postes comme caméras IP des DVR du client connecté.
 * Lecture : tout utilisateur du client ; écriture : admin du client.
 */
@Controller("cameras")
export class CamerasController {
  constructor(private readonly cameras: CamerasService) {}

  @Get()
  list(@TenantId() t: string, @Query("dvrId", OptionalUuid) dvrId?: string) {
    return this.cameras.list(t, dvrId);
  }

  @Get("dvr")
  dvr(@TenantId() t: string, @Query("dvrId", OptionalUuid) dvrId?: string) {
    return this.cameras.dvrInfo(t, dvrId);
  }

  @Get("available-streams")
  available(@TenantId() t: string, @Query("dvrId", OptionalUuid) dvrId?: string) {
    return this.cameras.availableStreams(t, dvrId);
  }

  @Post()
  @UseGuards(AdminGuard)
  create(@TenantId() t: string, @Body() dto: CreateCameraDto) {
    return this.cameras.create(t, dto);
  }

  @Patch(":id")
  @UseGuards(AdminGuard)
  update(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateCameraDto) {
    return this.cameras.update(t, id, dto);
  }

  @Delete(":id")
  @UseGuards(AdminGuard)
  @HttpCode(204)
  remove(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.cameras.remove(t, id);
  }

  @Post("sync")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  sync(@TenantId() t: string, @Query("dvrId", OptionalUuid) dvrId?: string) {
    return this.cameras.sync(t, dvrId);
  }
}
