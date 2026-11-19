import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomBytes, randomInt } from "node:crypto";
import { Repository } from "typeorm";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { Dvr } from "../dvrs/dvr.entity";
import { CloudflareApi, cloudflareConfig, type IngressRule } from "../sites/cloudflare.api";
import { ProvisionSiteDto } from "./gateway.dto";
import { Gateway, type SiteResources } from "./gateway.entity";
import { view, type GatewayView } from "./gateways.service";

/** Services locaux du serveur de site, publiés par son tunnel (ports par défaut de l'installation). */
const SERVICES = {
  mtx: "http://localhost:9997", // API MediaMTX
  play: "http://localhost:9996", // relecture MediaMTX
  go2rtc: "http://localhost:1984", // go2rtc des postes (ONVIF pour les DVR)
  live: "http://localhost:1980", // go2rtc viewer (direct MSE, relecture DVR)
} as const;

/** Nom du service Windows installé sur le serveur du site (distinct de tout autre cloudflared de la machine). */
const WIN_SERVICE = "ScreenViewer-Tunnel";

/** Caractères sans ambiguïté pour le mot de passe ONVIF (le DVR exige 8 à 16 caractères). */
const ALNUM = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomString = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join("");

export interface SiteInstall {
  gateway: GatewayView;
  hostnames: Record<keyof typeof SERVICES, string>;
  /** Mot de passe ONVIF généré : à reporter dans go2rtc.yaml (onvif.password) du serveur du site. */
  onvifPassword: string;
  /** Script PowerShell (administrateur) qui installe le tunnel du site en service Windows. */
  script: string;
}

/**
 * Création automatique d'un site client par l'API Cloudflare : tunnel, noms publics sous CF_DOMAIN, jeton de
 * service + application Access, puis passerelle déjà remplie. Le client n'a plus qu'à lancer le script
 * d'installation sur son serveur local. Rien n'est créé chez Cloudflare si CF_* est absent du .env.
 */
@Injectable()
export class SiteProvisioningService {
  private readonly log = new Logger(SiteProvisioningService.name);
  private readonly cf: CloudflareApi | null;

  constructor(
    @InjectRepository(Gateway) private readonly repo: Repository<Gateway>,
    @InjectRepository(Dvr) private readonly dvrs: Repository<Dvr>,
  ) {
    const cfg = cloudflareConfig();
    this.cf = cfg ? new CloudflareApi(cfg) : null;
  }

  status() {
    return { enabled: !!this.cf, domain: this.cf?.domain ?? null };
  }

  private api(): CloudflareApi {
    if (!this.cf)
      throw new ServiceUnavailableException({
        message: "Création automatique des sites désactivée : CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID et CF_DOMAIN manquent sur le serveur",
        code: "provisioningDisabled",
      });
    return this.cf;
  }

  private hostnames(slug: string) {
    const d = this.api().domain;
    return {
      mtx: `s-${slug}-mtx.${d}`,
      play: `s-${slug}-play.${d}`,
      go2rtc: `s-${slug}-go2rtc.${d}`,
      live: `s-${slug}-live.${d}`,
    };
  }

  async provision(tenantId: string, dto: ProvisionSiteDto): Promise<SiteInstall> {
    const cf = this.api();
    if (await this.repo.findOneBy({ tenantId, name: dto.name }))
      throw new ConflictException({ message: `Une passerelle nommée "${dto.name}" existe déjà`, code: null });

    const slug = randomBytes(4).toString("hex").slice(0, 6);
    const hosts = this.hostnames(slug);
    const label = `ScreenViewer - ${slug}`;
    const res: SiteResources = { dnsIds: [] };
    try {
      const tunnel = await cf.createTunnel(`screenviewer-${slug}`);
      res.tunnelId = tunnel.id;
      const rules: IngressRule[] = (Object.keys(SERVICES) as (keyof typeof SERVICES)[]).map((k) => ({
        hostname: hosts[k],
        service: SERVICES[k],
      }));
      await cf.setIngress(tunnel.id, rules);
      for (const h of Object.values(hosts)) res.dnsIds!.push(await cf.createTunnelDns(h, tunnel.id));
      const token = await cf.createServiceToken(label);
      res.serviceTokenId = token.id;
      res.policyId = await cf.createServiceTokenPolicy(label, token.id);
      res.appId = await cf.createAccessApp(label, Object.values(hosts), res.policyId);

      const onvifPassword = randomString(12);
      const g = await this.repo.save(
        this.repo.create({
          tenantId,
          name: dto.name,
          siteSlug: slug,
          mediamtxApiUrl: `https://${hosts.mtx}`,
          // WebRTC ne traverse pas le tunnel (UDP) : le mur passe en MSE ; on garde une adresse valide.
          mediamtxWebrtcUrl: `https://${hosts.mtx}`,
          mediamtxPlaybackUrl: `https://${hosts.play}`,
          // Vue par les go2rtc du site, sur la même machine que MediaMTX.
          mediamtxRtspUrl: "rtsp://127.0.0.1:8554",
          recordingsDir: null,
          go2rtcUrl: `https://${hosts.go2rtc}`,
          viewerGo2rtcUrl: `https://${hosts.live}`,
          liveMode: "mse",
          onvifHost: dto.serverLanIp,
          onvifPort: 1984,
          onvifUser: "admin",
          onvifPasswordEnc: encryptSecret(onvifPassword),
          accessClientId: token.clientId,
          accessClientSecretEnc: encryptSecret(token.clientSecret),
          cfResources: res,
          tunnelTokenEnc: encryptSecret(tunnel.token),
        }),
      );
      this.log.log(`Site ${slug} créé pour le client ${tenantId}`);
      return { gateway: view(g), hostnames: hosts, onvifPassword, script: installScript(tunnel.token, onvifPassword) };
    } catch (e) {
      this.log.error(`Création du site ${slug} échouée : ${(e as Error).message}`);
      await this.cleanup(res);
      throw new BadRequestException({ message: `Création du site impossible : ${(e as Error).message}`, code: "provisioningFailed" });
    }
  }

  /** Infos d'installation d'un site automatique (réaffichables tant que le site existe). */
  async install(tenantId: string, id: string): Promise<SiteInstall> {
    const g = await this.repo
      .createQueryBuilder("g")
      .addSelect(["g.onvifPasswordEnc", "g.tunnelTokenEnc"])
      .where("g.id = :id AND g.tenant_id = :tenantId", { id, tenantId })
      .getOne();
    if (!g) throw new NotFoundException({ message: "Passerelle introuvable", code: null });
    if (!g.siteSlug || !g.tunnelTokenEnc)
      throw new BadRequestException({ message: "Cette passerelle n'a pas été créée automatiquement", code: "notProvisioned" });
    const onvifPassword = decryptSecret(g.onvifPasswordEnc);
    return {
      gateway: view(g),
      hostnames: this.hostnames(g.siteSlug),
      onvifPassword,
      script: installScript(decryptSecret(g.tunnelTokenEnc), onvifPassword),
    };
  }

  /** Supprime la passerelle, puis ses ressources Cloudflare si elle a été créée automatiquement. */
  async remove(tenantId: string, id: string): Promise<void> {
    const g = await this.repo
      .createQueryBuilder("g")
      .addSelect("g.cfResources")
      .where("g.id = :id AND g.tenant_id = :tenantId", { id, tenantId })
      .getOne();
    if (!g) throw new NotFoundException({ message: "Passerelle introuvable", code: null });
    const n = await this.dvrs.countBy({ gatewayId: id, tenantId });
    if (n > 0)
      throw new ConflictException({
        message: `${n} DVR utilise(nt) encore cette passerelle : changez leur passerelle ou supprimez-les d'abord`,
        code: "gatewayInUse",
      });
    await this.repo.delete({ id, tenantId });
    if (g.cfResources) await this.cleanup(g.cfResources);
  }

  /** Suppression au mieux, dans l'ordre inverse de la création ; un échec est journalisé, pas bloquant. */
  private async cleanup(res: SiteResources) {
    const cf = this.cf;
    if (!cf) return;
    const steps: [string, () => Promise<void>][] = [
      ...(res.appId ? [["application Access", () => cf.deleteAccessApp(res.appId!)] as [string, () => Promise<void>]] : []),
      ...(res.policyId ? [["stratégie Access", () => cf.deletePolicy(res.policyId!)] as [string, () => Promise<void>]] : []),
      ...(res.serviceTokenId ? [["jeton de service", () => cf.deleteServiceToken(res.serviceTokenId!)] as [string, () => Promise<void>]] : []),
      ...(res.dnsIds ?? []).map((d) => ["DNS", () => cf.deleteDns(d)] as [string, () => Promise<void>]),
      ...(res.tunnelId ? [["tunnel", () => cf.deleteTunnel(res.tunnelId!)] as [string, () => Promise<void>]] : []),
    ];
    for (const [what, run] of steps)
      await run().catch((e: Error) => this.log.warn(`Suppression Cloudflare (${what}) échouée : ${e.message}`));
  }
}

/**
 * Script PowerShell à lancer en administrateur sur le serveur du site : télécharge cloudflared et l'installe
 * en service Windows avec le jeton du tunnel (stocké dans un fichier lisible par SYSTEM et les administrateurs).
 */
function installScript(tunnelToken: string, onvifPassword: string): string {
  return `# ScreenViewer - installation du tunnel du site (PowerShell en administrateur)
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:ProgramData "ScreenViewer"
New-Item -ItemType Directory -Force $dir | Out-Null
$exe = Join-Path $dir "cloudflared.exe"
if (-not (Test-Path $exe)) {
  Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $exe
}
$tok = Join-Path $dir "tunnel.token"
Set-Content -Path $tok -Value '${tunnelToken}' -NoNewline -Encoding ascii
icacls $tok /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null
$svc = "${WIN_SERVICE}"
if (Get-Service $svc -ErrorAction SilentlyContinue) { Stop-Service $svc -Force; sc.exe delete $svc | Out-Null; Start-Sleep 2 }
New-Service -Name $svc -DisplayName "ScreenViewer - Tunnel du site" -StartupType Automatic -BinaryPathName ('"' + $exe + '" tunnel --no-autoupdate run --token-file "' + $tok + '"') | Out-Null
Start-Service $svc
Write-Host "Tunnel installé et démarré (service $svc)." -ForegroundColor Green
Write-Host "Mot de passe ONVIF à mettre dans go2rtc.yaml (onvif > password) : ${onvifPassword}" -ForegroundColor Yellow
`;
}
