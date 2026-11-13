import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

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
