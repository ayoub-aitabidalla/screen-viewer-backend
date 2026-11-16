import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { Dvr } from "../dvrs/dvr.entity";
import { Go2rtcClient } from "../nvr/go2rtc.client";
import { CreateGatewayDto, UpdateGatewayDto } from "./gateway.dto";
import { Gateway } from "./gateway.entity";

/** Vue renvoyée par l'API : sans mot de passe. */
export type GatewayView = Omit<Gateway, "onvifPasswordEnc" | "tenant">;

const view = (g: Gateway): GatewayView => {
  const { onvifPasswordEnc, tenant, ...rest } = g;
  return rest;
};

/** Passerelle avec le mot de passe ONVIF déchiffré : usage interne uniquement, jamais renvoyé par l'API. */
export type GatewaySecrets = GatewayView & { onvifPassword: string };

@Injectable()
export class GatewaysService {
  constructor(
    @InjectRepository(Gateway) private readonly repo: Repository<Gateway>,
    @InjectRepository(Dvr) private readonly dvrs: Repository<Dvr>,
  ) {}

  async list(tenantId: string): Promise<GatewayView[]> {
    return (await this.repo.find({ where: { tenantId }, order: { name: "ASC" } })).map(view);
  }

  /** Passerelle du client, sinon 404 (on ne révèle pas celles des autres clients). */
  async get(tenantId: string, id: string): Promise<Gateway> {
    const g = await this.repo.findOneBy({ id, tenantId });
    if (!g) throw new NotFoundException({ message: "Passerelle introuvable", code: null });
    return g;
  }

  /** Passerelle précisée, sinon la première du client ; erreur explicite si le client n'en a aucune. */
  async resolve(tenantId: string, id?: string): Promise<Gateway> {
    if (id) return this.get(tenantId, id);
    const g = await this.repo.findOne({ where: { tenantId }, order: { name: "ASC" } });
    if (!g) throw new BadRequestException({ message: "Aucune passerelle vidéo configurée pour ce client", code: "noGateway" });
    return g;
  }

  async secrets(tenantId: string, id: string): Promise<GatewaySecrets> {
    const g = await this.repo
      .createQueryBuilder("g")
      .addSelect("g.onvifPasswordEnc")
      .where("g.id = :id AND g.tenant_id = :tenantId", { id, tenantId })
      .getOne();
    if (!g) throw new NotFoundException({ message: "Passerelle introuvable", code: null });
    return { ...view(g), onvifPassword: decryptSecret(g.onvifPasswordEnc) };
  }

  async create(tenantId: string, dto: CreateGatewayDto): Promise<GatewayView> {
    const { onvifPassword, recordingsDir, ...rest } = dto;
    await this.assertNameFree(tenantId, dto.name);
    const g = this.repo.create({ ...rest, recordingsDir: recordingsDir || null, tenantId, onvifPasswordEnc: encryptSecret(onvifPassword) });
    return view(await this.repo.save(g));
  }

  async update(tenantId: string, id: string, dto: UpdateGatewayDto): Promise<GatewayView> {
    const g = await this.get(tenantId, id);
    const { onvifPassword, recordingsDir, ...rest } = dto;
    if (rest.name && rest.name !== g.name) await this.assertNameFree(tenantId, rest.name);
    const patch: Partial<Gateway> = { ...rest };
    if (recordingsDir !== undefined) patch.recordingsDir = recordingsDir || null;
    if (onvifPassword) patch.onvifPasswordEnc = encryptSecret(onvifPassword);
    await this.repo.update({ id, tenantId }, patch);
    return view(await this.get(tenantId, id));
  }

  /** Refusé tant qu'un DVR utilise cette passerelle. */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.get(tenantId, id);
    const n = await this.dvrs.countBy({ gatewayId: id, tenantId });
    if (n > 0)
      throw new ConflictException({
        message: `${n} DVR utilise(nt) encore cette passerelle : changez leur passerelle ou supprimez-les d'abord`,
        code: "gatewayInUse",
      });
    await this.repo.delete({ id, tenantId });
  }

  /** Test de MediaMTX (API) et de go2rtc avec les réglages enregistrés. */
  async info(tenantId: string, id: string) {
    const g = await this.get(tenantId, id);
    const mediamtx = await fetch(`${g.mediamtxApiUrl.replace(/\/$/, "")}/v3/paths/list?itemsPerPage=1000`, { signal: AbortSignal.timeout(5000) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = (await r.json()) as { items?: { ready?: boolean }[] };
        return { reachable: true, streams: (b.items ?? []).filter((p) => p.ready).length, error: null as string | null };
      })
      .catch((e: Error) => ({ reachable: false, streams: 0, error: `MediaMTX injoignable : ${e.message}` }));
    const go2rtc = await new Go2rtcClient(g.go2rtcUrl)
      .listStreams()
      .then((s) => ({ reachable: true, streams: s.length, error: null as string | null }))
      .catch((e: Error) => ({ reachable: false, streams: 0, error: e.message }));
    return { mediamtx, go2rtc };
  }

  private async assertNameFree(tenantId: string, name: string) {
    if (await this.repo.findOneBy({ tenantId, name }))
      throw new ConflictException({ message: `Une passerelle nommée "${name}" existe déjà`, code: null });
  }
}
