import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

/** Un poste de travail enregistré par le DVR comme caméra IP (via go2rtc/ONVIF). */
@Entity("cameras")
export class Camera {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Nom affiché (et nom du canal sur le DVR). */
  @Column({ length: 32 })
  name: string;

  /** Chemin du flux dans MediaMTX, ex. "desktop-ql3bupt/0". */
  @Column({ name: "stream_path", unique: true, length: 128 })
  streamPath: string;

  /** Nom du flux dans go2rtc (= profil ONVIF), ex. "desktop-ql3bupt_0". */
  @Column({ name: "go2rtc_name", unique: true, length: 128 })
  go2rtcName: string;

  /** Id du canal IP sur le DVR (InputProxy). */
  @Column({ name: "dvr_channel_id", type: "int", unique: true })
  dvrChannelId: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
