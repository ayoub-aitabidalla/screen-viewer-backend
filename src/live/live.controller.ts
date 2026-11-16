import { Body, Controller, Delete, Get, Header, HttpException, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Readable } from "stream";
import { TenantId } from "../auth/tenant.decorator";
import { LiveService } from "./live.service";

/** ?gatewayId= facultatif : absent = première passerelle du client. */
type GwQuery = { gatewayId?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const gwId = (q: GwQuery) => (q.gatewayId && UUID.test(q.gatewayId) ? q.gatewayId : undefined);

/**
 * Mur en direct, poste agrandi et historique : relais vers le MediaMTX de la passerelle du client connecté.
 * Toutes les routes exigent la session (guard JWT global). Le cookie httpOnly est aussi envoyé par <video src>.
 */
@Controller("live")
export class LiveController {
  constructor(private readonly live: LiveService) {}

  @Get("paths")
  async paths(@TenantId() t: string, @Query() q: GwQuery) {
    return this.live.paths(await this.live.gateway(t, gwId(q)));
  }

  @Get("publishers")
  async publishers(@TenantId() t: string, @Query() q: GwQuery) {
    return this.live.publishers(await this.live.gateway(t, gwId(q)));
  }

  @Get("retention")
  async retention(@TenantId() t: string, @Query() q: GwQuery) {
    return this.live.retention(await this.live.gateway(t, gwId(q)));
  }

  @Get("recordings")
  async recordings(@TenantId() t: string, @Query() q: GwQuery) {
    return this.live.recordings(await this.live.gateway(t, gwId(q)));
  }

  @Get("recording")
  async recording(@TenantId() t: string, @Query() q: GwQuery & { path?: string }) {
    return this.live.recording(await this.live.gateway(t, gwId(q)), q.path ?? "");
  }

  @Get("recording-bases")
  async recordingBases(@TenantId() t: string, @Query() q: GwQuery) {
    return this.live.recordingBases(await this.live.gateway(t, gwId(q)));
  }

  /** Relecture : MP4 fragmenté relayé en flux (pas de requêtes Range, comme le serveur playback de MediaMTX). */
  @Get("playback")
  async playback(@TenantId() t: string, @Query() q: GwQuery & Record<string, string>, @Req() req: Request, @Res() res: Response) {
    const url = this.live.playbackUrl(await this.live.gateway(t, gwId(q)), q);
    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());
    const up = await this.live.upstream(url, { signal: ctrl.signal });
    res.status(up.status);
    const type = up.headers.get("content-type");
    if (type) res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    if (!up.body) return res.end();
    Readable.fromWeb(up.body as never)
      .on("error", () => res.destroy())
      .pipe(res);
  }

  /** WHEP : offre SDP du navigateur → réponse SDP de MediaMTX. La vidéo elle-même circule ensuite en direct (ICE/UDP). */
  @Post("whep")
  @Header("Cache-Control", "no-store")
  async whep(@TenantId() t: string, @Query() q: GwQuery & { path?: string }, @Body() sdp: string, @Res() res: Response) {
    if (typeof sdp !== "string" || !sdp.startsWith("v=")) throw new HttpException({ message: "Offre SDP attendue (application/sdp)", code: null }, 400);
    const g = await this.live.gateway(t, gwId(q));
    const up = await this.live.upstream(this.live.whepUrl(g, q.path ?? ""), {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: sdp,
    });
    const text = await up.text();
    if (!up.ok) throw new HttpException({ message: `WHEP : HTTP ${up.status}`, code: null }, up.status === 404 ? 404 : 502);
    // La session est refermée via notre relais : on réécrit Location vers /api/live/whep?session=…
    const loc = up.headers.get("location");
    if (loc?.startsWith("/"))
      res.setHeader("Location", `/api/live/whep?gatewayId=${g.id}&session=${encodeURIComponent(loc)}`);
    res.status(201).type("application/sdp").send(text);
  }

  @Delete("whep")
  async whepClose(@TenantId() t: string, @Query() q: GwQuery & { session?: string }, @Res() res: Response) {
    const g = await this.live.gateway(t, gwId(q));
    const up = await this.live.upstream(this.live.sessionUrl(g, q.session), { method: "DELETE" }).catch(() => null);
    res.status(up?.ok ? 200 : 204).end();
  }
}
