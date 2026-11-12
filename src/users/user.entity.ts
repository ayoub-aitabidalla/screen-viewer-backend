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

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
