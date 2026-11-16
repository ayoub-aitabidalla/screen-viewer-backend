import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

/** Un client : ses utilisateurs, ses DVR et ses caméras sont isolés des autres clients. */
@Entity("tenants")
export class Tenant {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true, length: 64 })
  name: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
