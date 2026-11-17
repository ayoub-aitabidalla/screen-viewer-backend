import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { DvrsService } from "../dvrs/dvrs.service";
import { DvrChannel, DvrClient, DvrError } from "../nvr/dvr.client";
import { Go2rtcClient } from "../nvr/go2rtc.client";
import { dvrClientFor, go2rtcClientFor, NvrSettings } from "../nvr/nvr.settings";
import { siteFetch } from "../sites/site-fetch";
import { Camera } from "./camera.entity";
import { CreateCameraDto, UpdateCameraDto } from "./camera.dto";

export type CameraState = "online" | "offline" | "missing" | "unknown";

export interface CameraView {
  id: string;
  dvrId: string;
  name: string;
  streamPath: string;
  dvrChannelId: number;
  /** online/offline : statut du canal sur le DVR ; missing : canal absent du DVR ; unknown : DVR injoignable. */
  state: CameraState;
  detail: string | null;
  createdAt: Date;
}

export interface UnmanagedChannel {
  id: number;
  name: string;
  ipAddress: string;
  port: number;
  online: boolean | null;
}

export interface CameraList {
  /** DVR affiché ; null si le client n'a encore aucun DVR. */
  dvrId: string | null;
  cameras: CameraView[];
  unmanaged: UnmanagedChannel[];
  dvrError: string | null;
}

/** Accès à un DVR précis d'un client, construit à chaque opération à partir de la table "dvrs". */
interface DvrCtx {
  tenantId: string;
  dvrId: string;
  s: NvrSettings;
  dvr: DvrClient;
  go2rtc: Go2rtcClient;
}

/** Réessaie une opération DVR : juste après un ajout, le DVR refuse un moment les modifications du canal. */
async function retry<T>(fn: () => Promise<T>, attempts = 6, delayMs = 1500): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || (e instanceof DvrError && e.httpStatus === 401)) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const toGo2rtcName = (streamPath: string) => streamPath.replace(/\//g, "_");
const rtspBase = (s: NvrSettings) => s.mediamtxRtspUrl.replace(/\/$/, "");

/** Convertit une erreur DVR/go2rtc en réponse HTTP lisible par le viewer. */
function upstream(e: unknown): HttpException {
  if (e instanceof HttpException) return e;
  if (e instanceof DvrError) return new BadGatewayException({ message: e.message, code: e.subStatusCode ?? e.statusString ?? null });
  return new BadGatewayException({ message: (e as Error).message, code: null });
}

@Injectable()
export class CamerasService implements OnApplicationBootstrap {
  private readonly log = new Logger(CamerasService.name);
  /** Modifications (DVR + go2rtc + base) sérialisées par DVR, pour éviter deux ajouts sur le même id de canal. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    @InjectRepository(Camera) private readonly repo: Repository<Camera>,
    private readonly dvrs: DvrsService,
  ) {}

  private exclusive<T>(dvrId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(dvrId) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(dvrId, run.catch(() => undefined));
    return run;
  }

  private async ctx(tenantId: string, dvrId: string): Promise<DvrCtx> {
    const s = await this.dvrs.settings(tenantId, dvrId);
    return {
      tenantId,
      dvrId,
      s,
      dvr: dvrClientFor(s),
      go2rtc: go2rtcClientFor(s),
    };
  }

  /** Caméra du client, sinon 404. */
  private async camera(tenantId: string, id: string): Promise<Camera> {
    const cam = await this.repo.findOneBy({ id, tenantId });
    if (!cam) throw new NotFoundException();
    return cam;
  }

  /** Synchronise les DVR de tous les clients, sans bloquer le démarrage si l'un est injoignable. */
  async onApplicationBootstrap() {
    for (const d of await this.dvrs.allIds()) {
      try {
        const r = await this.sync(d.tenantId, d.id);
        this.log.log(`Synchronisation DVR "${d.name}" : ${r.imported} importé(s), ${r.repaired} canal(aux) corrigé(s)`);
      } catch (e) {
        this.log.warn(`Synchronisation DVR "${d.name}" au démarrage impossible : ${(e as Error).message}`);
      }
    }
  }

  /** Canaux du DVR qui pointent vers le go2rtc de ce site. */
  private ours(c: DvrCtx, ch: DvrChannel) {
    return ch.protocol === "ONVIF" && ch.ipAddress === c.s.go2rtcOnvifHost && ch.port === c.s.go2rtcOnvifPort;
  }

  private channelInput(c: DvrCtx, cam: Pick<Camera, "dvrChannelId" | "name">, srcInputPort: number) {
    return {
      id: cam.dvrChannelId,
      name: cam.name,
      ipAddress: c.s.go2rtcOnvifHost,
      port: c.s.go2rtcOnvifPort,
      srcInputPort,
      userName: c.s.go2rtcOnvifUser,
      password: c.s.go2rtcOnvifPassword,
    };
  }

  /** Infos du DVR précisé, ou de l'unique DVR du client. */
  async dvrInfo(tenantId: string, dvrId?: string) {
    const d = await this.dvrs.resolve(tenantId, dvrId);
    return this.dvrs.info(tenantId, d.id);
  }

  async list(tenantId: string, dvrId?: string): Promise<CameraList> {
    if (!dvrId && (await this.dvrs.list(tenantId)).length === 0)
      return { dvrId: null, cameras: [], unmanaged: [], dvrError: "Aucun DVR configuré pour ce client" };
    const c = await this.ctx(tenantId, (await this.dvrs.resolve(tenantId, dvrId)).id);
    const cams = await this.repo.find({ where: { tenantId, dvrId: c.dvrId }, order: { dvrChannelId: "ASC" } });
    let channels: DvrChannel[] | null = null;
    let status = new Map<number, { online: boolean; detail: string }>();
    let dvrError: string | null = null;
    try {
      const [ch, st] = await Promise.all([c.dvr.listChannels(), c.dvr.channelStatus().catch(() => [])]);
      channels = ch;
      status = new Map(st.map((x) => [x.id, x]));
    } catch (e) {
      dvrError = (e as Error).message;
    }
    const managedIds = new Set(cams.map((x) => x.dvrChannelId));
    return {
      dvrId: c.dvrId,
      cameras: cams.map((x) => {
        const ch = channels?.find((y) => y.id === x.dvrChannelId);
        const st = status.get(x.dvrChannelId);
        const state: CameraState = !channels ? "unknown" : !ch ? "missing" : st?.online ? "online" : "offline";
        return {
          id: x.id,
          dvrId: x.dvrId,
          name: x.name,
          streamPath: x.streamPath,
          dvrChannelId: x.dvrChannelId,
          state,
          detail: st?.detail ?? null,
          createdAt: x.createdAt,
        };
      }),
      unmanaged: (channels ?? [])
        .filter((x) => !managedIds.has(x.id))
        .map((x) => ({ id: x.id, name: x.name, ipAddress: x.ipAddress, port: x.port, online: status.get(x.id)?.online ?? null })),
      dvrError,
    };
  }

  private async view(tenantId: string, cam: Camera): Promise<CameraView> {
    return (await this.list(tenantId, cam.dvrId)).cameras.find((x) => x.id === cam.id)!;
  }

  async create(tenantId: string, dto: CreateCameraDto): Promise<CameraView> {
    const dvrId = (await this.dvrs.resolve(tenantId, dto.dvrId)).id;
    const cam = await this.exclusive(dvrId, async () => {
      const c = await this.ctx(tenantId, dvrId);
      const streamPath = dto.streamPath.replace(/^\/+|\/+$/g, "");
      if (await this.repo.findOneBy({ dvrId, streamPath }))
        throw new ConflictException({ message: `Le flux ${streamPath} est déjà configuré`, code: null });
      const go2rtcName = toGo2rtcName(streamPath);

      let createdStream = false;
      try {
        const streams = await c.go2rtc.streams();
        if (!streams.has(go2rtcName)) {
          await c.go2rtc.putStream(go2rtcName, `${rtspBase(c.s)}/${streamPath}`);
          createdStream = true;
        }
        const port = (await c.go2rtc.onvifProfileOrder()).indexOf(go2rtcName) + 1;
        if (port === 0) throw new Error(`go2rtc n'expose pas le profil ONVIF "${go2rtcName}"`);

        // Id proposé (premier libre) ; le DVR peut en choisir un autre. Pas de contrôle de capacité : le DVR refusera s'il est plein.
        const used = new Set((await c.dvr.listChannels()).map((x) => x.id));
        let id = 1;
        while (used.has(id)) id++;

        const cam = this.repo.create({ tenantId, dvrId, name: dto.name, streamPath, go2rtcName, dvrChannelId: id });
        // Le DVR attribue son propre id et un nom générique (« IPCamera 0x ») : on récupère l'id, puis on applique le nom.
        cam.dvrChannelId = await c.dvr.addChannel(this.channelInput(c, cam, port));
        try {
          await retry(() => c.dvr.updateChannel(this.channelInput(c, cam, port)));
        } catch (e) {
          await retry(() => c.dvr.deleteChannel(cam.dvrChannelId)).catch((err) =>
            this.log.error(`Annulation impossible : canal ${cam.dvrChannelId} à retirer à la main (${err.message})`),
          );
          throw e;
        }
        await this.repo.save(cam);
        // Un nouveau flux peut décaler l'ordre des profils : on réaligne les autres canaux.
        if (createdStream) await this.realign(c).catch((e) => this.log.warn(`Réalignement : ${e.message}`));
        return cam;
      } catch (e) {
        if (createdStream) await c.go2rtc.deleteStream(go2rtcName).catch(() => undefined);
        throw upstream(e);
      }
    });
    return this.view(tenantId, cam);
  }

  async update(tenantId: string, id: string, dto: UpdateCameraDto): Promise<CameraView> {
    const { dvrId } = await this.camera(tenantId, id);
    const cam = await this.exclusive(dvrId, async () => {
      const cam = await this.camera(tenantId, id);
      const c = await this.ctx(tenantId, dvrId);
      try {
        const port = (await c.go2rtc.onvifProfileOrder()).indexOf(cam.go2rtcName) + 1;
        if (port === 0) throw new Error(`go2rtc n'expose pas le profil ONVIF "${cam.go2rtcName}"`);
        await c.dvr.updateChannel(this.channelInput(c, { ...cam, name: dto.name }, port));
      } catch (e) {
        throw upstream(e);
      }
      cam.name = dto.name;
      return this.repo.save(cam);
    });
    return this.view(tenantId, cam);
  }

  /** Retire le canal du DVR et le flux go2rtc. Les enregistrements déjà sur le disque du DVR sont conservés. */
  async remove(tenantId: string, id: string): Promise<void> {
    const { dvrId } = await this.camera(tenantId, id);
    return this.exclusive(dvrId, async () => {
      const cam = await this.camera(tenantId, id);
      const c = await this.ctx(tenantId, dvrId);
      try {
        const exists = (await c.dvr.listChannels()).some((x) => x.id === cam.dvrChannelId);
        if (exists) await c.dvr.deleteChannel(cam.dvrChannelId);
      } catch (e) {
        throw upstream(e);
      }
      await this.repo.remove(cam);
      await c.go2rtc.deleteStream(cam.go2rtcName).catch((e) => this.log.warn(`Suppression flux go2rtc : ${e.message}`));
      await this.realign(c).catch((e) => this.log.warn(`Réalignement : ${e.message}`));
    });
  }

  /**
   * Met à jour srcInputPort (et les identifiants ONVIF) des canaux gérés dont le profil a changé de position,
   * et recrée dans go2rtc les flux manquants (ex. go2rtc redémarré sans eux).
   */
  private async realign(c: DvrCtx): Promise<number> {
    const cams = await this.repo.findBy({ tenantId: c.tenantId, dvrId: c.dvrId });
    const streams = await c.go2rtc.streams();
    for (const x of cams) if (!streams.has(x.go2rtcName)) await c.go2rtc.putStream(x.go2rtcName, `${rtspBase(c.s)}/${x.streamPath}`);
    const order = await c.go2rtc.onvifProfileOrder();
    const channels = await c.dvr.listChannels();
    let fixed = 0;
    for (const x of cams) {
      const ch = channels.find((y) => y.id === x.dvrChannelId);
      const port = order.indexOf(x.go2rtcName) + 1;
      if (!ch || port === 0 || ch.srcInputPort === port) continue;
      await c.dvr.updateChannel(this.channelInput(c, x, port));
      fixed++;
    }
    return fixed;
  }

  /**
   * Importe en base les canaux du DVR qui pointent déjà vers le go2rtc du site (ex. canal créé à la main),
   * en leur appliquant les identifiants ONVIF actuels, puis réaligne tous les canaux.
   */
  async sync(tenantId: string, dvrIdOrNone?: string): Promise<{ imported: number; repaired: number }> {
    const dvrId = (await this.dvrs.resolve(tenantId, dvrIdOrNone)).id;
    return this.exclusive(dvrId, async () => {
      const c = await this.ctx(tenantId, dvrId);
      try {
        const [channels, cams, order, streams] = await Promise.all([
          c.dvr.listChannels(),
          this.repo.findBy({ tenantId, dvrId }),
          c.go2rtc.onvifProfileOrder(),
          c.go2rtc.streams(),
        ]);
        const managed = new Set(cams.map((x) => x.dvrChannelId));
        const base = rtspBase(c.s);
        let imported = 0;
        for (const ch of channels.filter((x) => this.ours(c, x) && !managed.has(x.id))) {
          const go2rtcName = order[ch.srcInputPort - 1];
          if (!go2rtcName || cams.some((x) => x.go2rtcName === go2rtcName)) continue;
          const src = streams.get(go2rtcName);
          const streamPath = src?.startsWith(base + "/") ? src.slice(base.length + 1) : go2rtcName.replace(/_(\d+)$/, "/$1");
          const cam = this.repo.create({ tenantId, dvrId, name: ch.name.slice(0, 32), streamPath, go2rtcName, dvrChannelId: ch.id });
          await c.dvr.updateChannel(this.channelInput(c, cam, ch.srcInputPort));
          await this.repo.save(cam);
          cams.push(cam);
          imported++;
        }
        const repaired = await this.realign(c);
        return { imported, repaired };
      } catch (e) {
        throw upstream(e);
      }
    });
  }

  /** Flux publiés dans le MediaMTX du site par les postes, pour proposer ceux qui ne sont pas encore configurés. */
  async availableStreams(tenantId: string, dvrId?: string): Promise<string[]> {
    if (!dvrId && (await this.dvrs.list(tenantId)).length === 0) return [];
    const d = await this.dvrs.resolve(tenantId, dvrId);
    const configured = new Set((await this.repo.findBy({ tenantId, dvrId: d.id })).map((x) => x.streamPath));
    const s = await this.dvrs.settings(tenantId, d.id);
    const mtx = s.mediamtxApiUrl.replace(/\/$/, "");
    try {
      const res = await siteFetch(s.access, `${mtx}/v3/paths/list?itemsPerPage=1000`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as { items?: { name: string }[] };
      return (body.items ?? []).map((p) => p.name).filter((n) => !configured.has(n)).sort();
    } catch {
      return [];
    }
  }
}
