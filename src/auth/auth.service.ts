import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { DataSource } from "typeorm";
import { Tenant } from "../tenants/tenant.entity";
import { User } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import type { JwtPayload } from "./jwt-auth.guard";

// Comparé même si l'utilisateur n'existe pas : même temps de réponse, on ne révèle pas les noms valides.
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 12);

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly ds: DataSource,
    private readonly config: ConfigService,
  ) {}

  private async session(user: User) {
    const payload: JwtPayload = { sub: user.id, username: user.username, tenantId: user.tenantId };
    return {
      token: await this.jwt.signAsync(payload),
      user: { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId },
    };
  }

  async login(username: string, password: string) {
    const user = await this.users.findWithHash(username);
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException("Identifiants invalides");
    return this.session(user);
  }

  /** Changement de mot de passe de l'utilisateur connecté (mot de passe actuel exigé). */
  async changePassword(userId: string, current: string, next: string) {
    const repo = this.ds.getRepository(User);
    const user = await repo.createQueryBuilder("u").addSelect("u.passwordHash").where("u.id = :userId", { userId }).getOne();
    if (!user || !(await bcrypt.compare(current, user.passwordHash)))
      throw new UnauthorizedException({ message: "Mot de passe actuel incorrect", code: "wrongPassword" });
    if (current === next)
      throw new ConflictException({ message: "Le nouveau mot de passe doit être différent de l'actuel", code: "samePassword" });
    await repo.update({ id: userId }, { passwordHash: await bcrypt.hash(next, 12) });
  }

  /**
   * Inscription d'un nouveau client : crée le client et son premier administrateur, puis ouvre la session.
   * Désactivable avec SIGNUP_ENABLED=false (ex. installation chez un seul client).
   */
  async signup(organization: string, username: string, password: string) {
    if (this.config.get("SIGNUP_ENABLED") === "false")
      throw new ForbiddenException({ message: "La création de compte client est désactivée", code: "signupDisabled" });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.ds.transaction(async (m) => {
      if (await m.findOneBy(Tenant, { name: organization }))
        throw new ConflictException({ message: `Le client « ${organization} » existe déjà`, code: "tenantExists" });
      if (await m.findOneBy(User, { username }))
        throw new ConflictException({ message: `Le nom d'utilisateur « ${username} » est déjà pris`, code: "usernameTaken" });
      const tenant = await m.save(m.create(Tenant, { name: organization }));
      return m.save(m.create(User, { username, passwordHash, role: "admin", tenantId: tenant.id }));
    });
    return this.session(user);
  }
}
