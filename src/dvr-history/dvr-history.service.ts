import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Camera } from "../cameras/camera.entity";
import { Dvr } from "../dvrs/dvr.entity";
import { DvrsService } from "../dvrs/dvrs.service";
import { DvrError } from "../nvr/dvr.client";
import { dvrClientFor } from "../nvr/nvr.settings";
import { NO_ACCESS, siteFetch, type SiteAccess } from "../sites/site-fetch";

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
export class DvrHistoryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(DvrHistoryService.name);
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(Camera) private readonly cameras: Repository<Camera>,
    @InjectRepository(Dvr) private readonly dvrRepo: Repository<Dvr>,
    private readonly dvrs: DvrsService,
  ) {}

  onApplicationBootstrap() {
    void this.sweep();
    this.sweeper = setInterval(() => void this.sweep(), 5 * 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  /**
   * Retire de chaque go2rtc les sources de relecture DVR restées sans lecteur. Elles contiennent les identifiants
   * du DVR ; normalement libérées à la fin de chaque lecture, elles peuvent rester si le backend a été arrêté en cours.
   */
  private async sweep() {
    const seen = new Set<string>();
    for (const d of await this.dvrs.allIds().catch(() => [])) {
      try {
        const s = await this.dvrs.settings(d.tenantId, d.id);
        // go2rtc viewer : toute source temporaire sans lecteur (relecture DVR ou direct MSE).
        // go2rtc des DVR : anciennes sources de relecture créées avant le go2rtc viewer (ne doivent plus exister).
        const targets: [string | null | undefined, (name: string) => boolean][] = [
          [s.go2rtcViewerUrl, (n) => n.startsWith("rtsp://")],
          [s.go2rtcUrl, (n) => n.startsWith("rtsp://") && n.includes("/Streaming/tracks/")],
        ];
        for (const [url, temporary] of targets) {
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const base = url.replace(/\/$/, "");
          const res = await siteFetch(s.access, `${base}/api/streams`, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) continue;
          const streams = (await res.json()) as Record<string, { consumers?: unknown[] } | null>;
          const stale = Object.entries(streams ?? {}).filter(([name, v]) => temporary(name) && !v?.consumers?.length);
          for (const [name] of stale) await this.release(s.access ?? NO_ACCESS, base, name);
          if (stale.length) this.log.log(`${stale.length} source(s) temporaire(s) sans lecteur retirée(s) de ${base} (${d.name})`);
        }
      } catch {
        /* passerelle injoignable : on réessaiera au prochain passage */
      }
    }
  }

  /** Postes enregistrés du client, avec le nom de leur DVR (pour faire le lien avec les postes du mur). */
  async list(tenantId: string) {
    const [cams, dvrs] = await Promise.all([
      this.cameras.find({ where: { tenantId }, order: { name: "ASC" } }),
      this.dvrRepo.find({ where: { tenantId }, select: { id: true, name: true, gatewayId: true } }),
    ]);
    const byId = new Map(dvrs.map((d) => [d.id, d]));
    return cams.map((c) => ({
      id: c.id,
      name: c.name,
      streamPath: c.streamPath,
      dvrId: c.dvrId,
      dvrName: byId.get(c.dvrId)?.name ?? "",
      gatewayId: byId.get(c.dvrId)?.gatewayId ?? null,
      channel: c.dvrChannelId,
    }));
  }

  /** Poste du client + accès à son DVR (mot de passe déchiffré, usage interne). */
  private async context(tenantId: string, cameraId: string) {
    const cam = await this.cameras.findOneBy({ id: cameraId, tenantId });
    if (!cam) throw new NotFoundException({ message: "Poste enregistré introuvable", code: null });
    const s = await this.dvrs.settings(tenantId, cam.dvrId);
    const dvr = dvrClientFor(s, 15000);
    return {
      cam,
      dvr,
      // Relecture : toujours par le go2rtc viewer, jamais par un go2rtc qu'un DVR utilise en ONVIF
      // (une source de plus y deviendrait un 2e profil, et le DVR pourrait enregistrer la relecture).
      go2rtcUrl: s.go2rtcViewerUrl ? s.go2rtcViewerUrl.replace(/\/$/, "") : null,
      access: s.access ?? NO_ACCESS,
      track: trackOf(cam.dvrChannelId),
    };
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
  async playback(
    tenantId: string,
    cameraId: string,
    startIso?: string,
  ): Promise<{ mp4Url: string; go2rtcUrl: string; src: string; access: SiteAccess }> {
    const start = new Date(startIso ?? "");
    if (Number.isNaN(start.getTime())) throw new BadRequestException({ message: "Horaire de départ invalide", code: null });
    const { dvr, go2rtcUrl, access, track } = await this.context(tenantId, cameraId);
    if (!go2rtcUrl)
      throw new BadRequestException({
        message: "Relecture indisponible : renseignez le go2rtc viewer de la passerelle (onglet Passerelles)",
        code: "noViewerGo2rtc",
      });
    let offset: number;
    try {
      offset = await dvr.utcOffsetMinutes();
    } catch (e) {
      throw upstream(e);
    }
    const src = dvr.playbackRtspUrl(track, compact(toDvr(start, offset)));
    return { mp4Url: `${go2rtcUrl}/api/stream.mp4?src=${encodeURIComponent(src)}`, go2rtcUrl, src, access };
  }

  /**
   * Fichier MP4 de la plage [from, from + duration] : segments du DVR qui la couvrent, assemblés et découpés par ffmpeg.
   * À supprimer avec cleanup() une fois envoyé.
   */
  /**
   * Prépare un export : vérifie la plage et cherche les segments sur le DVR (rapide), sans rien télécharger.
   * Renvoie de quoi lancer exportRange en tâche de fond (voir DvrExportsService).
   */
  async planExport(tenantId: string, cameraId: string, fromIso?: string, durationSec?: number) {
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
      if (!recs.length) throw new NotFoundException({ message: "Aucun enregistrement sur cette plage", code: "noRecording" });
      // La plage commence au plus tôt au début du premier segment trouvé, et finit au plus tard à la fin du dernier.
      const start = Math.max(from.getTime(), recs[0].startMs);
      const length = Math.min(to.getTime(), recs[recs.length - 1].endMs) - start;
      const stamp = new Date(start).toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = `${cam.streamPath.replace(/[^A-Za-z0-9._-]+/g, "_")}_${stamp}_${Math.round(length / 1000)}s.mp4`;
      return { dvr, recs, start, durationSec: length / 1000, name };
    } catch (e) {
      throw upstream(e);
    }
  }

  /** Retire de go2rtc la source temporaire de relecture (go2rtc la garde en mémoire, identifiants compris). */
  async release(access: SiteAccess, go2rtcUrl: string, src: string): Promise<void> {
    await siteFetch(access, `${go2rtcUrl}/api/streams?src=${encodeURIComponent(src)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8000),
    }).catch(() => undefined);
  }
}
