import { BadGatewayException, BadRequestException, HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Camera } from "../cameras/camera.entity";
import { Dvr } from "../dvrs/dvr.entity";
import { DvrsService } from "../dvrs/dvrs.service";
import { DvrClient, DvrError } from "../nvr/dvr.client";
import { exportRange } from "./dvr-export";

/** Un segment enregistré par le DVR, horaires en UTC réel (le front affiche en heure locale du navigateur). */
export interface DvrSegment {
  start: string;
  /** Durée en secondes. */
  duration: number;
}

const MAX_RANGE_MS = 7 * 86400_000;
/** Durée maximale d'un téléchargement (taille des fichiers temporaires : ~400 Mo par heure sur ce DVR). */
const MAX_EXPORT_SEC = 2 * 3600;

/** Piste d'enregistrement Hikvision d'un canal : canal × 100 + 1 (flux principal), ex. canal 5 → 501. */
export const trackOf = (channel: number) => channel * 100 + 1;

/** Date UTC → heure locale du DVR au format ISAPI ("2026-11-16T14:00:00Z", le Z n'indique pas l'UTC). */
const toDvr = (d: Date, offsetMin: number) => new Date(d.getTime() + offsetMin * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
/** Heure locale du DVR (ISAPI) → Date UTC réelle. */
const fromDvr = (s: string, offsetMin: number) => new Date(Date.parse(s.endsWith("Z") ? s : `${s}Z`) - offsetMin * 60_000);
/** Format compact des URL RTSP de relecture : 20261116T140000Z. */
const compact = (isapi: string) => isapi.replace(/[-:]/g, "");

function upstream(e: unknown): HttpException {
  if (e instanceof HttpException) return e;
  if (e instanceof DvrError) return new BadGatewayException({ message: e.message, code: e.subStatusCode ?? e.statusString ?? null });
  return new BadGatewayException({ message: (e as Error).message, code: null });
}

/**
 * Historique et relecture depuis le DVR : recherche ISAPI des segments d'un poste enregistré,
 * puis relecture RTSP du DVR convertie en MP4 par le go2rtc de la passerelle. Tout est filtré par client.
 */
@Injectable()
export class DvrHistoryService {
  constructor(
    @InjectRepository(Camera) private readonly cameras: Repository<Camera>,
    @InjectRepository(Dvr) private readonly dvrRepo: Repository<Dvr>,
    private readonly dvrs: DvrsService,
  ) {}

  /** Postes enregistrés du client, avec le nom de leur DVR (pour faire le lien avec les postes du mur). */
  async list(tenantId: string) {
    const [cams, dvrs] = await Promise.all([
      this.cameras.find({ where: { tenantId }, order: { name: "ASC" } }),
      this.dvrRepo.find({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const names = new Map(dvrs.map((d) => [d.id, d.name]));
    return cams.map((c) => ({
      id: c.id,
      name: c.name,
      streamPath: c.streamPath,
      dvrId: c.dvrId,
      dvrName: names.get(c.dvrId) ?? "",
      channel: c.dvrChannelId,
    }));
  }

  /** Poste du client + accès à son DVR (mot de passe déchiffré, usage interne). */
  private async context(tenantId: string, cameraId: string) {
    const cam = await this.cameras.findOneBy({ id: cameraId, tenantId });
    if (!cam) throw new NotFoundException({ message: "Poste enregistré introuvable", code: null });
    const s = await this.dvrs.settings(tenantId, cam.dvrId);
    const dvr = new DvrClient({ host: s.dvrHost, user: s.dvrUser, password: s.dvrPassword, timeoutMs: 15000 });
    return { cam, dvr, go2rtcUrl: s.go2rtcUrl.replace(/\/$/, ""), track: trackOf(cam.dvrChannelId) };
  }

  async segments(tenantId: string, cameraId: string, fromIso?: string, toIso?: string): Promise<{ segments: DvrSegment[]; dvrOffsetMinutes: number }> {
    const from = new Date(fromIso ?? "");
    const to = new Date(toIso ?? "");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from)
      throw new BadRequestException({ message: "Plage horaire invalide (from / to au format ISO)", code: null });
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new BadRequestException({ message: "Plage limitée à 7 jours", code: null });
    const { dvr, track } = await this.context(tenantId, cameraId);
    try {
      const offset = await dvr.utcOffsetMinutes();
      const recs = await dvr.searchRecordings(track, toDvr(from, offset), toDvr(to, offset));
      const segments = recs
        .map((r) => {
          const start = fromDvr(r.start, offset);
          return { start: start.toISOString(), duration: Math.max(0, (fromDvr(r.end, offset).getTime() - start.getTime()) / 1000) };
        })
        .filter((s) => s.duration > 0)
        .sort((a, b) => b.start.localeCompare(a.start));
      return { segments, dvrOffsetMinutes: offset };
    } catch (e) {
      throw upstream(e);
    }
  }

  /**
   * Prépare une relecture à partir de `startIso` : renvoie l'URL MP4 de go2rtc (à relayer au navigateur)
   * et la source à supprimer de go2rtc à la fin (elle contient les identifiants du DVR).
   */
  async playback(tenantId: string, cameraId: string, startIso?: string): Promise<{ mp4Url: string; go2rtcUrl: string; src: string }> {
    const start = new Date(startIso ?? "");
    if (Number.isNaN(start.getTime())) throw new BadRequestException({ message: "Horaire de départ invalide", code: null });
    const { dvr, go2rtcUrl, track } = await this.context(tenantId, cameraId);
    let offset: number;
    try {
      offset = await dvr.utcOffsetMinutes();
    } catch (e) {
      throw upstream(e);
    }
    const src = dvr.playbackRtspUrl(track, compact(toDvr(start, offset)));
    return { mp4Url: `${go2rtcUrl}/api/stream.mp4?src=${encodeURIComponent(src)}`, go2rtcUrl, src };
  }

  /**
   * Fichier MP4 de la plage [from, from + duration] : segments du DVR qui la couvrent, assemblés et découpés par ffmpeg.
   * À supprimer avec cleanup() une fois envoyé.
   */
  async export(tenantId: string, cameraId: string, fromIso?: string, durationSec?: number) {
    const from = new Date(fromIso ?? "");
    const dur = Number(durationSec);
    if (Number.isNaN(from.getTime()) || !(dur > 0)) throw new BadRequestException({ message: "Début ou durée invalide", code: null });
    if (dur > MAX_EXPORT_SEC) throw new BadRequestException({ message: `Durée limitée à ${MAX_EXPORT_SEC / 3600} h par téléchargement`, code: null });
    const { cam, dvr, track } = await this.context(tenantId, cameraId);
    const to = new Date(from.getTime() + dur * 1000);
    try {
      const offset = await dvr.utcOffsetMinutes();
      const recs = (await dvr.searchRecordings(track, toDvr(from, offset), toDvr(to, offset)))
        .map((r) => ({ playbackUri: r.playbackUri, startMs: fromDvr(r.start, offset).getTime(), endMs: fromDvr(r.end, offset).getTime() }))
        .filter((r) => r.endMs > from.getTime() && r.startMs < to.getTime())
        .sort((a, b) => a.startMs - b.startMs);
      if (!recs.length) throw new NotFoundException({ message: "Aucun enregistrement sur cette plage", code: null });
      // La plage commence au plus tôt au début du premier segment trouvé.
      const start = Math.max(from.getTime(), recs[0].startMs);
      const length = Math.min(to.getTime(), recs[recs.length - 1].endMs) - start;
      const out = await exportRange(dvr, recs, start, length / 1000);
      const stamp = new Date(start).toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = `${cam.streamPath.replace(/[^A-Za-z0-9._-]+/g, "_")}_${stamp}_${Math.round(length / 1000)}s.mp4`;
      return { ...out, name };
    } catch (e) {
      throw upstream(e);
    }
  }

  /** Retire de go2rtc la source temporaire de relecture (go2rtc la garde en mémoire, identifiants compris). */
  async release(go2rtcUrl: string, src: string): Promise<void> {
    await fetch(`${go2rtcUrl}/api/streams?src=${encodeURIComponent(src)}`, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  }
}
