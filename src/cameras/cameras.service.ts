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
import { DvrChannel, DvrClient, DvrError } from "../nvr/dvr.client";
import { Go2rtcClient } from "../nvr/go2rtc.client";
import { NvrSettings, nvrSettings } from "../nvr/nvr.settings";
import { Camera } from "./camera.entity";
import { CreateCameraDto, UpdateCameraDto } from "./camera.dto";

export type CameraState = "online" | "offline" | "missing" | "unknown";

export interface CameraView {
  id: string;
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

/** Convertit une erreur DVR/go2rtc en réponse HTTP lisible par le viewer. */
function upstream(e: unknown): HttpException {
  if (e instanceof HttpException) return e;
  if (e instanceof DvrError) return new BadGatewayException({ message: e.message, code: e.subStatusCode ?? e.statusString ?? null });
  return new BadGatewayException({ message: (e as Error).message, code: null });
}

@Injectable()
export class CamerasService implements OnApplicationBootstrap {
  private readonly log = new Logger(CamerasService.name);
  private readonly s: NvrSettings = nvrSettings();
  private readonly dvr = new DvrClient({ host: this.s.dvrHost, user: this.s.dvrUser, password: this.s.dvrPassword });
  private readonly go2rtc = new Go2rtcClient(this.s.go2rtcUrl);
  /** Les modifications (DVR + go2rtc + base) sont sérialisées pour éviter deux ajouts sur le même id de canal. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(@InjectRepository(Camera) private readonly repo: Repository<Camera>) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async onApplicationBootstrap() {
    try {
      const r = await this.sync();
      this.log.log(`Synchronisation DVR : ${r.imported} importé(s), ${r.repaired} canal(aux) corrigé(s)`);
    } catch (e) {
      this.log.warn(`Synchronisation DVR au démarrage impossible : ${(e as Error).message}`);
    }
  }

  /** Canaux du DVR qui pointent vers notre go2rtc. */
  private ours(c: DvrChannel) {
    return c.protocol === "ONVIF" && c.ipAddress === this.s.go2rtcOnvifHost && c.port === this.s.go2rtcOnvifPort;
  }

  private channelInput(cam: Pick<Camera, "dvrChannelId" | "name">, srcInputPort: number) {
    return {
      id: cam.dvrChannelId,
      name: cam.name,
      ipAddress: this.s.go2rtcOnvifHost,
      port: this.s.go2rtcOnvifPort,
      srcInputPort,
      userName: this.s.go2rtcOnvifUser,
      password: this.s.go2rtcOnvifPassword,
    };
  }

  async dvrInfo() {
    try {
      return { reachable: true, ...(await this.dvr.deviceInfo()), error: null };
    } catch (e) {
      return { reachable: false, error: (e as Error).message };
    }
  }

  async list(): Promise<{ cameras: CameraView[]; unmanaged: UnmanagedChannel[]; dvrError: string | null }> {
    const cams = await this.repo.find({ order: { dvrChannelId: "ASC" } });
    let channels: DvrChannel[] | null = null;
    let status = new Map<number, { online: boolean; detail: string }>();
    let dvrError: string | null = null;
    try {
      const [ch, st] = await Promise.all([this.dvr.listChannels(), this.dvr.channelStatus().catch(() => [])]);
      channels = ch;
      status = new Map(st.map((x) => [x.id, x]));
    } catch (e) {
      dvrError = (e as Error).message;
    }
    const managedIds = new Set(cams.map((c) => c.dvrChannelId));
    return {
      cameras: cams.map((c) => {
        const ch = channels?.find((x) => x.id === c.dvrChannelId);
        const st = status.get(c.dvrChannelId);
        const state: CameraState = !channels ? "unknown" : !ch ? "missing" : st?.online ? "online" : "offline";
        return { id: c.id, name: c.name, streamPath: c.streamPath, dvrChannelId: c.dvrChannelId, state, detail: st?.detail ?? null, createdAt: c.createdAt };
      }),
      unmanaged: (channels ?? [])
        .filter((c) => !managedIds.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, ipAddress: c.ipAddress, port: c.port, online: status.get(c.id)?.online ?? null })),
      dvrError,
    };
  }

  create(dto: CreateCameraDto): Promise<CameraView> {
    return this.exclusive(async () => {
      const streamPath = dto.streamPath.replace(/^\/+|\/+$/g, "");
      if (await this.repo.findOneBy({ streamPath })) throw new ConflictException({ message: `Le flux ${streamPath} est déjà configuré`, code: null });
      const go2rtcName = toGo2rtcName(streamPath);

      let createdStream = false;
      try {
        const streams = await this.go2rtc.streams();
        if (!streams.has(go2rtcName)) {
          await this.go2rtc.putStream(go2rtcName, `${this.s.mediamtxRtspUrl.replace(/\/$/, "")}/${streamPath}`);
          createdStream = true;
        }
        const order = await this.go2rtc.onvifProfileOrder();
        const port = order.indexOf(go2rtcName) + 1;
        if (port === 0) throw new Error(`go2rtc n'expose pas le profil ONVIF "${go2rtcName}"`);

        // Id proposé (premier libre) ; le DVR peut en choisir un autre. Pas de contrôle de capacité : le DVR refusera s'il est plein.
        const used = new Set((await this.dvr.listChannels()).map((c) => c.id));
        let id = 1;
        while (used.has(id)) id++;

        const cam = this.repo.create({ name: dto.name, streamPath, go2rtcName, dvrChannelId: id });
        // Le DVR attribue son propre id et un nom générique (« IPCamera 0x ») : on récupère l'id, puis on applique le nom.
        cam.dvrChannelId = await this.dvr.addChannel(this.channelInput(cam, port));
        try {
          await retry(() => this.dvr.updateChannel(this.channelInput(cam, port)));
        } catch (e) {
          await retry(() => this.dvr.deleteChannel(cam.dvrChannelId)).catch((err) =>
            this.log.error(`Annulation impossible : canal ${cam.dvrChannelId} à retirer à la main (${err.message})`),
          );
          throw e;
        }
        await this.repo.save(cam);
        // Un nouveau flux peut décaler l'ordre des profils : on réaligne les autres canaux.
        if (createdStream) await this.realign().catch((e) => this.log.warn(`Réalignement : ${e.message}`));
        return (await this.list()).cameras.find((c) => c.id === cam.id)!;
      } catch (e) {
        if (createdStream) await this.go2rtc.deleteStream(go2rtcName).catch(() => undefined);
        throw upstream(e);
      }
    });
  }

  update(id: string, dto: UpdateCameraDto): Promise<CameraView> {
    return this.exclusive(async () => {
      const cam = await this.repo.findOneBy({ id });
      if (!cam) throw new NotFoundException();
      try {
        const port = (await this.go2rtc.onvifProfileOrder()).indexOf(cam.go2rtcName) + 1;
        if (port === 0) throw new Error(`go2rtc n'expose pas le profil ONVIF "${cam.go2rtcName}"`);
        await this.dvr.updateChannel(this.channelInput({ ...cam, name: dto.name }, port));
      } catch (e) {
        throw upstream(e);
      }
      cam.name = dto.name;
      await this.repo.save(cam);
      return (await this.list()).cameras.find((c) => c.id === cam.id)!;
    });
  }

  /** Retire le canal du DVR et le flux go2rtc. Les enregistrements déjà sur le disque du DVR sont conservés. */
  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const cam = await this.repo.findOneBy({ id });
      if (!cam) throw new NotFoundException();
      try {
        const exists = (await this.dvr.listChannels()).some((c) => c.id === cam.dvrChannelId);
        if (exists) await this.dvr.deleteChannel(cam.dvrChannelId);
      } catch (e) {
        throw upstream(e);
      }
      await this.repo.remove(cam);
      await this.go2rtc.deleteStream(cam.go2rtcName).catch((e) => this.log.warn(`Suppression flux go2rtc : ${e.message}`));
      await this.realign().catch((e) => this.log.warn(`Réalignement : ${e.message}`));
    });
  }

  /**
   * Met à jour srcInputPort (et les identifiants ONVIF) des canaux gérés dont le profil a changé de position,
   * et recrée dans go2rtc les flux manquants (ex. go2rtc redémarré sans eux).
   */
  private async realign(): Promise<number> {
    const cams = await this.repo.find();
    const streams = await this.go2rtc.streams();
    for (const c of cams)
      if (!streams.has(c.go2rtcName)) await this.go2rtc.putStream(c.go2rtcName, `${this.s.mediamtxRtspUrl.replace(/\/$/, "")}/${c.streamPath}`);
    const order = await this.go2rtc.onvifProfileOrder();
    const channels = await this.dvr.listChannels();
    let fixed = 0;
    for (const c of cams) {
      const ch = channels.find((x) => x.id === c.dvrChannelId);
      const port = order.indexOf(c.go2rtcName) + 1;
      if (!ch || port === 0 || ch.srcInputPort === port) continue;
      await this.dvr.updateChannel(this.channelInput(c, port));
      fixed++;
    }
    return fixed;
  }

  /**
   * Importe en base les canaux du DVR qui pointent déjà vers notre go2rtc (ex. canal 5 créé à la main),
   * en leur appliquant les identifiants ONVIF actuels, puis réaligne tous les canaux.
   */
  sync(): Promise<{ imported: number; repaired: number }> {
    return this.exclusive(async () => {
      try {
        const [channels, cams, order, streams] = await Promise.all([
          this.dvr.listChannels(),
          this.repo.find(),
          this.go2rtc.onvifProfileOrder(),
          this.go2rtc.streams(),
        ]);
        const managed = new Set(cams.map((c) => c.dvrChannelId));
        const base = this.s.mediamtxRtspUrl.replace(/\/$/, "");
        let imported = 0;
        for (const ch of channels.filter((c) => this.ours(c) && !managed.has(c.id))) {
          const go2rtcName = order[ch.srcInputPort - 1];
          if (!go2rtcName || cams.some((c) => c.go2rtcName === go2rtcName)) continue;
          const src = streams.get(go2rtcName);
          const streamPath = src?.startsWith(base + "/") ? src.slice(base.length + 1) : go2rtcName.replace(/_(\d+)$/, "/$1");
          const cam = this.repo.create({ name: ch.name.slice(0, 32), streamPath, go2rtcName, dvrChannelId: ch.id });
          await this.dvr.updateChannel(this.channelInput(cam, ch.srcInputPort));
          await this.repo.save(cam);
          imported++;
        }
        const repaired = await this.realign();
        return { imported, repaired };
      } catch (e) {
        throw upstream(e);
      }
    });
  }

  /** Flux publiés dans MediaMTX par les postes, pour proposer ceux qui ne sont pas encore configurés. */
  async availableStreams(): Promise<string[]> {
    const configured = new Set((await this.repo.find()).map((c) => c.streamPath));
    const mtx = (process.env.MEDIAMTX_API_URL ?? "http://127.0.0.1:9997").replace(/\/$/, "");
    try {
      const res = await fetch(`${mtx}/v3/paths/list?itemsPerPage=1000`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { items?: { name: string }[] };
      return (body.items ?? []).map((p) => p.name).filter((n) => !configured.has(n)).sort();
    } catch {
      return [];
    }
  }
}
