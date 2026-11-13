import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../auth/admin.guard";
import { CreateCameraDto, UpdateCameraDto } from "./camera.dto";
import { CamerasService } from "./cameras.service";

/** Configuration des postes comme caméras IP du DVR. Lecture : tout utilisateur connecté ; écriture : admin. */
@Controller("cameras")
export class CamerasController {
  constructor(private readonly cameras: CamerasService) {}

  @Get()
  list() {
    return this.cameras.list();
  }

  @Get("dvr")
  dvr() {
    return this.cameras.dvrInfo();
  }

  @Get("available-streams")
  available() {
    return this.cameras.availableStreams();
  }

  @Post()
  @UseGuards(AdminGuard)
  create(@Body() dto: CreateCameraDto) {
    return this.cameras.create(dto);
  }

  @Patch(":id")
  @UseGuards(AdminGuard)
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateCameraDto) {
    return this.cameras.update(id, dto);
  }

  @Delete(":id")
  @UseGuards(AdminGuard)
  @HttpCode(204)
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.cameras.remove(id);
  }

  @Post("sync")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  sync() {
    return this.cameras.sync();
  }
}
