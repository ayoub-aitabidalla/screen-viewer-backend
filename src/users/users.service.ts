import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}

  /** Inclut le hash (colonne select:false) : réservé à la vérification du mot de passe. */
  findWithHash(username: string) {
    return this.repo
      .createQueryBuilder("u")
      .addSelect("u.passwordHash")
      .where("u.username = :username", { username })
      .getOne();
  }

  findById(id: string) {
    return this.repo.findOneBy({ id });
  }
}
