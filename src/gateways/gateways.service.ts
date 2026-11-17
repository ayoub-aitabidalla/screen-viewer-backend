import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { Dvr } from "../dvrs/dvr.entity";
import { Go2rtcClient } from "../nvr/go2rtc.client";
import { cloudflareError, siteFetch, siteFetcher, type SiteAccess } from "../sites/site-fetch";
import { CreateGatewayDto, UpdateGatewayDto } from "./gateway.dto";
import { Gateway } from "./gateway.entity";

/** Vue renvoyée par l'API : sans mot de passe ni secret Access. */
export type GatewayView = Omit<Gateway, "onvifPasswordEnc" | "accessClientSecretEnc" | "tenant">;

const view = (g: Gateway): GatewayView => {
  const { onvifPasswordEnc, accessClientSecretEnc, tenant, ...rest } = g;
  return rest;
};

/** Passerelle avec ses secrets déchiffrés : usage interne uniquement, jamais renvoyé par l'API. */
export type GatewaySecrets = GatewayView & { onvifPassword: string; access: SiteAccess };

/** Un jeton Access s'utilise en paire : identifiant et secret, ou ni l'un ni l'autre. */
function assertAccessPair(id: string | null | undefined, secret: string | null | undefined) {
  if (!!id !== !!secret)
    throw new BadRequestException({
      message: "Jeton Cloudflare Access incomplet : renseignez l'identifiant et le secret, ou aucun des deux",
      code: "accessIncomplete",
    });
}

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
      .addSelect(["g.onvifPasswordEnc", "g.accessClientSecretEnc"])
      .where("g.id = :id AND g.tenant_id = :tenantId", { id, tenantId })
      .getOne();
    if (!g) throw new NotFoundException({ message: "Passerelle introuvable", code: null });
    return {
      ...view(g),
      onvifPassword: decryptSecret(g.onvifPasswordEnc),
      access: {
        accessClientId: g.accessClientId,
        accessClientSecret: g.accessClientSecretEnc ? decryptSecret(g.accessClientSecretEnc) : null,
      },
    };
  }

  /** Jeton Cloudflare Access du site (déchiffré) : à passer à siteFetch pour joindre ses services. */
  async access(tenantId: string, id: string): Promise<SiteAccess> {
    return (await this.secrets(tenantId, id)).access;
  }

  async create(tenantId: string, dto: CreateGatewayDto): Promise<GatewayView> {
    const { onvifPassword, recordingsDir, accessClientId, accessClientSecret, ...rest } = dto;
    await this.assertNameFree(tenantId, dto.name);
    const g = this.repo.create({
      ...rest,
      recordingsDir: recordingsDir || null,
      tenantId,
      onvifPasswordEnc: encryptSecret(onvifPassword),
      accessClientId: accessClientId || null,
      accessClientSecretEnc: accessClientSecret ? encryptSecret(accessClientSecret) : null,
    });
    assertAccessPair(g.accessClientId, g.accessClientSecretEnc);
    return view(await this.repo.save(g));
  }

  async update(tenantId: string, id: string, dto: UpdateGatewayDto): Promise<GatewayView> {
    const g = await this.get(tenantId, id);
    const { onvifPassword, recordingsDir, accessClientId, accessClientSecret, ...rest } = dto;
    if (rest.name && rest.name !== g.name) await this.assertNameFree(tenantId, rest.name);
    const patch: Partial<Gateway> = { ...rest };
    if (recordingsDir !== undefined) patch.recordingsDir = recordingsDir || null;
    if (onvifPassword) patch.onvifPasswordEnc = encryptSecret(onvifPassword);
    // Jeton Access : identifiant vide = retour en accès direct (on efface aussi le secret).
    if (accessClientId !== undefined) {
      patch.accessClientId = accessClientId || null;
      if (!accessClientId) patch.accessClientSecretEnc = null;
    }
    if (accessClientSecret) patch.accessClientSecretEnc = encryptSecret(accessClientSecret);
    const current = await this.repo
      .createQueryBuilder("g")
      .addSelect("g.accessClientSecretEnc")
      .where("g.id = :id", { id })
      .getOne();
    assertAccessPair(
      patch.accessClientId !== undefined ? patch.accessClientId : g.accessClientId,
      patch.accessClientSecretEnc !== undefined ? patch.accessClientSecretEnc : (current?.accessClientSecretEnc ?? null),
    );
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
    const g = await this.secrets(tenantId, id);
    const mediamtx = await siteFetch(g.access, `${g.mediamtxApiUrl.replace(/\/$/, "")}/v3/paths/list?itemsPerPage=1000`, {
      signal: AbortSignal.timeout(8000),
    })
      .then(async (r) => {
        const cf = cloudflareError(r);
        if (cf) throw new Error(cf);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = (await r.json()) as { items?: { ready?: boolean }[] };
        return { reachable: true, streams: (b.items ?? []).filter((p) => p.ready).length, error: null as string | null };
      })
      .catch((e: Error) => ({ reachable: false, streams: 0, error: `MediaMTX injoignable : ${e.message}` }));
    const go2rtc = await new Go2rtcClient(g.go2rtcUrl, 8000, siteFetcher(g.access))
      .listStreams()
      .then((s) => ({ reachable: true, streams: s.length, error: null as string | null }))
      .catch((e: Error) => ({ reachable: false, streams: 0, error: e.message }));
    // go2rtc viewer (relecture, direct MSE) : facultatif, null s'il n'est pas configuré.
    const viewer = g.viewerGo2rtcUrl
      ? await new Go2rtcClient(g.viewerGo2rtcUrl, 8000, siteFetcher(g.access))
          .listStreams()
          .then((s) => ({ reachable: true, streams: s.length, error: null as string | null }))
          .catch((e: Error) => ({ reachable: false, streams: 0, error: e.message }))
      : null;
    return { mediamtx, go2rtc, viewer };
  }

  private async assertNameFree(tenantId: string, name: string) {
    if (await this.repo.findOneBy({ tenantId, name }))
      throw new ConflictException({ message: `Une passerelle nommée "${name}" existe déjà`, code: null });
  }
}
