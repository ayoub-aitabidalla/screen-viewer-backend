import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Tenant } from "../tenants/tenant.entity";

/**
 * Passerelle vidéo d'un site client : MediaMTX (reçoit les écrans des postes, sert le direct et la relecture)
 * + go2rtc (présente les flux aux DVR comme caméras ONVIF). Tous les flux d'une passerelle appartiennent à son client.
 * Sans passerelle, le client ne voit rien dans le mur en direct.
 */
@Entity("gateways")
@Index(["tenantId", "name"], { unique: true })
export class Gateway {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "tenant_id", type: "uuid" })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: "CASCADE" })
  @JoinColumn({ name: "tenant_id" })
  tenant?: Tenant;

  @Column({ length: 64 })
  name: string;

  /** API MediaMTX vue par le backend, ex. "http://127.0.0.1:9997". */
  @Column({ name: "mediamtx_api_url", length: 256 })
  mediamtxApiUrl: string;

  /** Serveur WebRTC (WHEP) de MediaMTX vu par le backend, ex. "http://127.0.0.1:8889". */
  @Column({ name: "mediamtx_webrtc_url", length: 256 })
  mediamtxWebrtcUrl: string;

  /** Serveur de relecture MediaMTX vu par le backend, ex. "http://127.0.0.1:9996". */
  @Column({ name: "mediamtx_playback_url", length: 256 })
  mediamtxPlaybackUrl: string;

  /** Base RTSP de MediaMTX vue par go2rtc, ex. "rtsp://127.0.0.1:8554". */
  @Column({ name: "mediamtx_rtsp_url", length: 256 })
  mediamtxRtspUrl: string;

  /**
   * Dossier recordings/ de MediaMTX lisible par le backend (facultatif : seulement si MediaMTX tourne sur la même machine).
   * Sert à retrouver les enregistrements des postes multi-écrans que l'API MediaMTX n'énumère pas.
   */
  @Column({ name: "recordings_dir", type: "varchar", length: 512, nullable: true })
  recordingsDir: string | null;

  /** API go2rtc vue par le backend, ex. "http://127.0.0.1:1984". */
  @Column({ name: "go2rtc_url", length: 256 })
  go2rtcUrl: string;

  /**
   * go2rtc « viewer » du site (ex. "http://127.0.0.1:1980" ou "https://screen-s1-live.domaine.com") : relecture DVR
   * et direct en MSE. Distinct des go2rtc utilisés par les DVR en ONVIF, pour qu'aucune source temporaire n'y
   * apparaisse comme un profil. Null = relecture et direct MSE indisponibles.
   */
  @Column({ name: "viewer_go2rtc_url", type: "varchar", length: 256, nullable: true })
  viewerGo2rtcUrl: string | null;

  /** Mode du mur en direct : "webrtc" (réseau local) ou "mse" (via le tunnel, par le go2rtc viewer). */
  @Column({ name: "live_mode", type: "varchar", length: 8, default: "webrtc" })
  liveMode: "webrtc" | "mse";

  /** Adresse de go2rtc telle que les DVR la joignent (IP LAN, pas 127.0.0.1). */
  @Column({ name: "onvif_host", length: 128 })
  onvifHost: string;

  @Column({ name: "onvif_port", type: "int", default: 1984 })
  onvifPort: number;

  @Column({ name: "onvif_user", length: 64, default: "admin" })
  onvifUser: string;

  /** 8 à 16 caractères (exigence du DVR), identique à onvif.password dans go2rtc.yaml. Chiffré. */
  @Column({ name: "onvif_password_enc", type: "text", select: false })
  onvifPasswordEnc: string;

  /**
   * Jeton de service Cloudflare Access du site (identifiant), quand ses services sont publiés par le tunnel
   * cloudflared du serveur local (URL https://s-<site>-…). Null = site joint directement (local / VPN).
   */
  @Column({ name: "access_client_id", type: "varchar", length: 128, nullable: true })
  accessClientId: string | null;

  /** Secret du jeton Access, chiffré. Jamais renvoyé par l'API. */
  @Column({ name: "access_client_secret_enc", type: "text", nullable: true, select: false })
  accessClientSecretEnc: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
