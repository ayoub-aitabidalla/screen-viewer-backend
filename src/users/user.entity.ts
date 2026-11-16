import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Tenant } from "../tenants/tenant.entity";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Client auquel appartient l'utilisateur : il ne voit que les DVR et caméras de ce client. */
  @Column({ name: "tenant_id", type: "uuid" })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: "CASCADE" })
  @JoinColumn({ name: "tenant_id" })
  tenant?: Tenant;

  /** Unique sur toute l'application : la connexion se fait par nom d'utilisateur seul. */
  @Column({ unique: true, length: 64 })
  username: string;

  /** Hash bcrypt, jamais renvoyé au client (select: false). */
  @Column({ name: "password_hash", select: false })
  passwordHash: string;

  /** admin : peut configurer les caméras ; viewer : consultation seule. */
  @Column({ type: "varchar", length: 16, default: "admin" })
  role: "admin" | "viewer";

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
