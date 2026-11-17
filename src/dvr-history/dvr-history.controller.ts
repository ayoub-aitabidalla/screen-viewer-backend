import { BadGatewayException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from "@nestjs/common";
import { IsISO8601, IsNumber, Max, Min } from "class-validator";
import type { Request, Response } from "express";
import { Readable } from "stream";
import { TenantId } from "../auth/tenant.decorator";
import { siteFetch } from "../sites/site-fetch";
import { DvrExportsService } from "./dvr-exports.service";
import { DvrHistoryService } from "./dvr-history.service";

export class StartExportDto {
  /** Début de la plage (ISO, UTC). */
  @IsISO8601() start: string;
  /** Durée en secondes, 2 h maximum. */
  @IsNumber() @Min(1) @Max(2 * 3600) duration: number;
}

/**
 * Historique & relecture depuis le DVR, pour les postes enregistrés du client connecté.
 * La vidéo est servie en MP4 fragmenté continu, lisible par <video src> (le cookie de session suit).
 */
@Controller("dvr-history")
export class DvrHistoryController {
  constructor(
    private readonly history: DvrHistoryService,
    private readonly exports: DvrExportsService,
  ) {}

  @Get("cameras")
  cameras(@TenantId() t: string) {
    return this.history.list(t);
  }

  /** Segments enregistrés entre from et to (ISO, 7 jours max). */
  @Get("cameras/:id/segments")
  segments(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.history.segments(t, id, from, to);
  }

  /**
   * Téléchargement MP4, en tâche de fond : lance la préparation de [start, start + duration] (2 h max) et répond tout de suite.
   * Le viewer suit ensuite GET exports/:id, puis récupère GET exports/:id/file. Pour un segment entier : son début et sa durée.
   */
  @Post("cameras/:id/exports")
  @HttpCode(202)
  startExport(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string, @Body() dto: StartExportDto) {
    return this.exports.start(t, id, dto.start, dto.duration);
  }

  /** État d'un export : en attente, en cours (pourcentage), prêt, échoué. */
  @Get("exports/:exportId")
  exportStatus(@TenantId() t: string, @Param("exportId", ParseUUIDPipe) exportId: string) {
    return this.exports.get(t, exportId);
  }

  /** Fichier MP4 prêt : envoyé immédiatement (pas d'attente), puis supprimé du serveur. */
  @Get("exports/:exportId/file")
  exportFile(@TenantId() t: string, @Param("exportId", ParseUUIDPipe) exportId: string, @Res() res: Response) {
    const f = this.exports.file(t, exportId);
    res.download(f.path, f.name, (err) => {
      // Envoi interrompu : on garde le fichier pour une nouvelle tentative (il expirera de lui-même).
      if (!err) f.done();
    });
  }

  /** Annule une préparation en cours, ou supprime un fichier prêt non récupéré. */
  @Delete("exports/:exportId")
  @HttpCode(204)
  cancelExport(@TenantId() t: string, @Param("exportId", ParseUUIDPipe) exportId: string) {
    return this.exports.cancel(t, exportId);
  }

  /** Relecture à partir de ?start= (ISO). Le flux continue tant que le navigateur lit ; fermé dès qu'il s'arrête. */
  @Get("cameras/:id/play")
  async play(@TenantId() t: string, @Param("id", ParseUUIDPipe) id: string, @Query("start") start: string, @Req() req: Request, @Res() res: Response) {
    const p = await this.history.playback(t, id, start);
    const ctrl = new AbortController();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      ctrl.abort();
      void this.history.release(p.access, p.go2rtcUrl, p.src);
    };
    req.on("close", release);

    let up: Response | globalThis.Response;
    try {
      up = await siteFetch(p.access, p.mp4Url, { signal: ctrl.signal });
    } catch (e) {
      release();
      throw new BadGatewayException({ message: `go2rtc injoignable : ${(e as Error).message}`, code: "go2rtcUnreachable" });
    }
    if (!up.ok || !up.body) {
      release();
      throw new BadGatewayException({ message: `Relecture refusée par go2rtc / DVR (HTTP ${up.status})`, code: null });
    }
    res.status(200);
    res.setHeader("Content-Type", up.headers.get("content-type") ?? "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(up.body as never)
      .on("error", () => {
        release();
        res.destroy();
      })
      .on("end", release)
      .pipe(res);
  }
}
