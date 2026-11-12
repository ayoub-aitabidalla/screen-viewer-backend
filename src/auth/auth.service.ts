import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { UsersService } from "../users/users.service";
import type { JwtPayload } from "./jwt-auth.guard";

// Comparé même si l'utilisateur n'existe pas : même temps de réponse, on ne révèle pas les noms valides.
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 12);

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string) {
    const user = await this.users.findWithHash(username);
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException("Identifiants invalides");
    const payload: JwtPayload = { sub: user.id, username: user.username };
    return { token: await this.jwt.signAsync(payload), user: { id: user.id, username: user.username } };
  }
}
