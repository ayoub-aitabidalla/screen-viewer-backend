import { BadGatewayException, Controller, Get, Param, ParseUUIDPipe, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Readable } from "stream";
import { TenantId } from "../auth/tenant.decorator";
import { siteFetch } from "../sites/site-fetch";
import { DvrHistoryService } from "./dvr-history.service";

/**
 * Historique & relecture depuis le DVR, pour les postes enregistrés du client connecté.
 * La vidéo est servie en MP4 fragmenté continu, lisible par <video src> (le cookie de session suit).
 */
@Controller("dvr-history")
export class DvrHistoryController {
  constructor(private readonly history: DvrHistoryService) {}

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
   * Téléchargement MP4 de ?start= (ISO) pendant ?duration= secondes (2 h max). Pour un segment entier : son début et sa durée.
   * Le fichier est préparé côté serveur (téléchargement DVR + ffmpeg), puis envoyé et supprimé.
   */
  @Get("cameras/:id/download")
  async download(
    @TenantId() t: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("start") start: string,
    @Query("duration") duration: string,
    @Res() res: Response,
  ) {
    const out = await this.history.export(t, id, start, Number(duration));
    res.download(out.file, out.name, () => void out.cleanup());
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
