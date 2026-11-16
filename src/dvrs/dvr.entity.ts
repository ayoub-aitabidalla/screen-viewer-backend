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

  /** Adresse ISAPI du DVR, ex. "192.168.8.64" ou "192.168.8.64:80". */
  @Column({ length: 128 })
  host: string;

  @Column({ length: 64 })
  username: string;

  @Column({ name: "password_enc", type: "text", select: false })
  passwordEnc: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
