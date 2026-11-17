import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Camera } from "../cameras/camera.entity";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { GatewaysService } from "../gateways/gateways.service";
import { dvrClientFor, NvrSettings } from "../nvr/nvr.settings";
import { CreateDvrDto, UpdateDvrDto } from "./dvr.dto";
import { Dvr } from "./dvr.entity";

/** Vue renvoyée par l'API : sans aucun mot de passe. */
export type DvrView = Omit<Dvr, "passwordEnc" | "tenant" | "gateway">;

const view = (d: Dvr): DvrView => {
  const { passwordEnc, tenant, gateway, ...rest } = d;
  return rest;
};

/** Un DVR joint par une URL de tunnel doit aussi avoir son adresse LAN (relecture RTSP par go2rtc sur le site). */
function assertLanHost(host: string, lanHost: string | null | undefined) {
  if (/^https?:\/\//i.test(host) && !lanHost)
    throw new BadRequestException({
      message: "Adresse LAN du DVR obligatoire quand son adresse ISAPI est une URL de tunnel (ex. 192.168.1.64)",
      code: "lanHostRequired",
    });
}

@Injectable()
export class DvrsService {
  constructor(
    @InjectRepository(Dvr) private readonly repo: Repository<Dvr>,
    @InjectRepository(Camera) private readonly cameras: Repository<Camera>,
    private readonly gateways: GatewaysService,
  ) {}

  async list(tenantId: string): Promise<DvrView[]> {
    return (await this.repo.find({ where: { tenantId }, order: { name: "ASC" } })).map(view);
  }

  /** Tous les DVR de tous les clients (synchronisation au démarrage uniquement). */
  allIds(): Promise<{ id: string; tenantId: string; name: string }[]> {
    return this.repo.find({ select: { id: true, tenantId: true, name: true } });
  }

  /** DVR du client, sinon 404 (on ne révèle pas l'existence d'un DVR d'un autre client). */
  async get(tenantId: string, id: string): Promise<Dvr> {
    const d = await this.repo.findOneBy({ id, tenantId });
    if (!d) throw new NotFoundException({ message: "DVR introuvable", code: null });
    return d;
  }

  /** DVR explicite, ou l'unique DVR du client si aucun n'est précisé. */
  async resolve(tenantId: string, id?: string): Promise<Dvr> {
    if (id) return this.get(tenantId, id);
    const all = await this.repo.find({ where: { tenantId }, take: 2 });
    if (all.length === 1) return all[0];
    throw new BadRequestException({
      message: all.length === 0 ? "Aucun DVR configuré pour ce client" : "Plusieurs DVR : précisez dvrId",
      code: all.length === 0 ? "noDvr" : "dvrIdRequired",
    });
  }

  /** Réglages complets (DVR + passerelle), mots de passe déchiffrés : usage interne uniquement, jamais renvoyé par l'API. */
  async settings(tenantId: string, id: string): Promise<NvrSettings> {
    const d = await this.repo
      .createQueryBuilder("d")
      .addSelect("d.passwordEnc")
      .where("d.id = :id AND d.tenant_id = :tenantId", { id, tenantId })
      .getOne();
    if (!d) throw new NotFoundException({ message: "DVR introuvable", code: null });
    const g = await this.gateways.secrets(tenantId, d.gatewayId);
    return {
      dvrHost: d.host,
      dvrLanHost: d.lanHost,
      access: g.access,
      dvrUser: d.username,
      dvrPassword: decryptSecret(d.passwordEnc),
      go2rtcUrl: g.go2rtcUrl,
      go2rtcViewerUrl: g.viewerGo2rtcUrl,
      go2rtcOnvifHost: g.onvifHost,
      go2rtcOnvifPort: g.onvifPort,
      go2rtcOnvifUser: g.onvifUser,
      go2rtcOnvifPassword: g.onvifPassword,
      mediamtxRtspUrl: g.mediamtxRtspUrl,
      mediamtxApiUrl: g.mediamtxApiUrl,
    };
  }

  async create(tenantId: string, dto: CreateDvrDto): Promise<DvrView> {
    const { password, lanHost, ...rest } = dto;
    await this.assertNameFree(tenantId, dto.name);
    await this.gateways.get(tenantId, dto.gatewayId); // la passerelle doit appartenir au même client
    assertLanHost(dto.host, lanHost);
    const d = this.repo.create({ ...rest, lanHost: lanHost || null, tenantId, passwordEnc: encryptSecret(password) });
    return view(await this.repo.save(d));
  }

  async update(tenantId: string, id: string, dto: UpdateDvrDto): Promise<DvrView> {
    const d = await this.get(tenantId, id);
    const { password, lanHost, ...rest } = dto;
    if (rest.name && rest.name !== d.name) await this.assertNameFree(tenantId, rest.name);
    assertLanHost(rest.host ?? d.host, lanHost !== undefined ? lanHost : d.lanHost);
    if (rest.gatewayId && rest.gatewayId !== d.gatewayId) {
      await this.gateways.get(tenantId, rest.gatewayId);
      // Les canaux existants pointent vers l'ancien go2rtc : il faut d'abord retirer les postes.
      if (await this.cameras.countBy({ dvrId: id, tenantId }))
        throw new ConflictException({ message: "Retirez d'abord les postes enregistrés par ce DVR avant de changer de passerelle", code: "dvrHasCameras" });
    }
    const patch: Partial<Dvr> = { ...rest };
    if (lanHost !== undefined) patch.lanHost = lanHost || null;
    if (password) patch.passwordEnc = encryptSecret(password);
    await this.repo.update({ id, tenantId }, patch);
    return view(await this.get(tenantId, id));
  }

  /** Refusé tant que des caméras gérées pointent vers ce DVR (les retirer d'abord). */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.get(tenantId, id);
    const n = await this.cameras.countBy({ dvrId: id, tenantId });
    if (n > 0) throw new ConflictException({ message: `Ce DVR enregistre encore ${n} poste(s) : retirez-les d'abord dans « Postes enregistrés »`, code: "dvrHasCameras" });
    await this.repo.delete({ id, tenantId });
  }

  /** Test de connexion au DVR avec les réglages enregistrés. */
  async info(tenantId: string, id: string) {
    const s = await this.settings(tenantId, id);
    try {
      const info = await dvrClientFor(s).deviceInfo();
      return { reachable: true, ...info, error: null };
    } catch (e) {
      return { reachable: false, error: (e as Error).message };
    }
  }

  private async assertNameFree(tenantId: string, name: string) {
    if (await this.repo.findOneBy({ tenantId, name })) throw new ConflictException({ message: `Un DVR nommé "${name}" existe déjà`, code: null });
  }
}
