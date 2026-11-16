import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Dvr } from "../dvrs/dvr.entity";

/** Un poste de travail enregistré par un DVR comme caméra IP (via go2rtc/ONVIF). */
@Entity("cameras")
@Index(["dvrId", "dvrChannelId"], { unique: true })
@Index(["dvrId", "streamPath"], { unique: true })
@Index(["dvrId", "go2rtcName"], { unique: true })
export class Camera {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Copie du client du DVR, pour filtrer directement par client. */
  @Column({ name: "tenant_id", type: "uuid" })
  tenantId: string;

  @Column({ name: "dvr_id", type: "uuid" })
  dvrId: string;

  /** RESTRICT : on ne supprime pas un DVR qui a encore des caméras gérées. */
  @ManyToOne(() => Dvr, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "dvr_id" })
  dvr?: Dvr;

  /** Nom affiché (et nom du canal sur le DVR). */
  @Column({ length: 32 })
  name: string;

  /** Chemin du flux dans MediaMTX, ex. "desktop-ql3bupt/0". */
  @Column({ name: "stream_path", length: 128 })
  streamPath: string;

  /** Nom du flux dans go2rtc (= profil ONVIF), ex. "desktop-ql3bupt_0". */
  @Column({ name: "go2rtc_name", length: 128 })
  go2rtcName: string;

  /** Id du canal IP sur le DVR (InputProxy). */
  @Column({ name: "dvr_channel_id", type: "int" })
  dvrChannelId: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
