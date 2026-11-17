import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Gateway } from "../gateways/gateway.entity";
import { Tenant } from "../tenants/tenant.entity";

/**
 * Un DVR/NVR Hikvision d'un client. Il enregistre les postes de sa passerelle vidéo (go2rtc + MediaMTX).
 * Le mot de passe ISAPI est chiffré (voir common/secret-box.ts) et n'est jamais renvoyé par l'API.
 */
@Entity("dvrs")
@Index(["tenantId", "name"], { unique: true })
export class Dvr {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "tenant_id", type: "uuid" })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: "CASCADE" })
  @JoinColumn({ name: "tenant_id" })
  tenant?: Tenant;

  /** Passerelle dont ce DVR enregistre les postes (même client). RESTRICT : pas de suppression d'une passerelle utilisée. */
  @Column({ name: "gateway_id", type: "uuid" })
  gatewayId: string;

  @ManyToOne(() => Gateway, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "gateway_id" })
  gateway?: Gateway;

  @Column({ length: 64 })
  name: string;

  /**
   * Adresse ISAPI du DVR telle que le backend la joint : "192.168.8.64", "192.168.8.64:80",
   * ou "https://s-a7k2-dvr1.tondomaine.com" quand le DVR est publié par le tunnel Cloudflare du site.
   */
  @Column({ length: 128 })
  host: string;

  /**
   * Adresse du DVR sur le réseau local du site (ex. "192.168.8.64"), utilisée par go2rtc pour la relecture RTSP.
   * Obligatoire quand host est une URL de tunnel ; facultative sinon (host sert alors aussi d'adresse LAN).
   */
  @Column({ name: "lan_host", type: "varchar", length: 128, nullable: true })
  lanHost: string | null;

  @Column({ length: 64 })
  username: string;

  @Column({ name: "password_enc", type: "text", select: false })
  passwordEnc: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
