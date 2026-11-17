import { BadGatewayException, BadRequestException, HttpException, Injectable } from "@nestjs/common";
import { promises as fs } from "fs";
import { GatewaysService } from "../gateways/gateways.service";
import { Gateway } from "../gateways/gateway.entity";
import { cloudflareError, siteFetch, type SiteAccess } from "../sites/site-fetch";

/** Passerelle + jeton Access déchiffré (usage interne). */
export type LiveGateway = Gateway & { access: SiteAccess };

/** Noms de flux MediaMTX acceptés (un poste : "pc-001", un écran : "pc-001/0"). */
const PATH_RE = /^[A-Za-z0-9._~\-]+(\/[A-Za-z0-9._~\-]+)*$/;

export function checkPath(path: string | undefined): string {
  if (!path || !PATH_RE.test(path) || path.split("/").includes("..")) throw new BadRequestException({ message: "Nom de flux invalide", code: null });
  return path;
}

/** Garde les "/" (chemins imbriqués) mais encode chaque segment, sinon MediaMTX redirige (301). */
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const base = (url: string) => url.replace(/\/$/, "");

/**
 * Accès au MediaMTX de la passerelle du client connecté. Le navigateur ne parle jamais directement à MediaMTX :
 * chaque appel passe par ici, après vérification du JWT, et ne touche que la passerelle du client.
 * Tous les flux d'une passerelle appartiennent à son client.
 */
@Injectable()
export class LiveService {
  constructor(private readonly gateways: GatewaysService) {}

  /** Passerelle du client avec son jeton Cloudflare Access (pour joindre ses services à travers le tunnel). */
  async gateway(tenantId: string, gatewayId?: string): Promise<LiveGateway> {
    const g = await this.gateways.resolve(tenantId, gatewayId);
    return Object.assign(g, { access: await this.gateways.access(tenantId, g.id) });
  }

  /** Requête vers MediaMTX ; erreur 502 lisible si la passerelle est injoignable. */
  async upstream(g: LiveGateway, url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
    let res: Response;
    try {
      res = await siteFetch(g.access, url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs), redirect: "manual" });
    } catch (e) {
      throw new BadGatewayException({ message: `MediaMTX injoignable : ${(e as Error).message}`, code: "gatewayUnreachable" });
    }
    const cf = cloudflareError(res);
    if (cf) throw new BadGatewayException({ message: cf, code: "gatewayUnreachable" });
    return res;
  }

  private async api<T>(g: LiveGateway, path: string): Promise<T> {
    const res = await this.upstream(g, base(g.mediamtxApiUrl) + path);
    if (!res.ok) throw new HttpException({ message: `API MediaMTX : HTTP ${res.status}`, code: null }, res.status === 404 ? 404 : 502);
    return (await res.json()) as T;
  }

  paths(g: LiveGateway) {
    return this.api(g, "/v3/paths/list?itemsPerPage=1000");
  }

  publishers(g: LiveGateway) {
    return this.api(g, "/v3/rtspsessions/list?itemsPerPage=1000");
  }

  async retention(g: LiveGateway) {
    const c = await this.api<{ record?: boolean; recordDeleteAfter?: string }>(g, "/v3/config/pathdefaults/get");
    return { record: !!c.record, recordDeleteAfter: c.recordDeleteAfter ?? "" };
  }

  recordings(g: LiveGateway) {
    return this.api(g, "/v3/recordings/list?itemsPerPage=1000");
  }

  recording(g: LiveGateway, path: string) {
    return this.api(g, `/v3/recordings/get/${encodePath(checkPath(path))}`);
  }

  /** Dossiers de premier niveau de recordings/ (postes ayant des enregistrements), si la passerelle a un recordingsDir. */
  async recordingBases(g: LiveGateway): Promise<string[]> {
    if (!g.recordingsDir) return [];
    try {
      const entries = await fs.readdir(g.recordingsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && PATH_RE.test(e.name)).map((e) => e.name);
    } catch {
      return [];
    }
  }

  playbackUrl(g: LiveGateway, q: Record<string, string>): string {
    const p = new URLSearchParams({ path: checkPath(q.path), start: q.start ?? "", duration: q.duration ?? "", format: q.format ?? "mp4" });
    if (!q.start || Number.isNaN(Date.parse(q.start)) || !(Number(q.duration) > 0))
      throw new BadRequestException({ message: "Paramètres de relecture invalides", code: null });
    return `${base(g.mediamtxPlaybackUrl)}/get?${p}`;
  }

  whepUrl(g: LiveGateway, path: string): string {
    return `${base(g.mediamtxWebrtcUrl)}/${encodePath(checkPath(path))}/whep`;
  }

  /** URL de session WHEP renvoyée par MediaMTX (Location relative) ; on refuse toute URL absolue (pas de relais ouvert). */
  sessionUrl(g: LiveGateway, session: string | undefined): string {
    if (!session || !session.startsWith("/") || session.startsWith("//") || session.includes(".."))
      throw new BadRequestException({ message: "Session WHEP invalide", code: null });
    return base(g.mediamtxWebrtcUrl) + session;
  }
}
