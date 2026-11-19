import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { UsersService } from "../users/users.service";
import { AuthThrottlerGuard } from "./auth-throttler.guard";
import { AUTH_COOKIE } from "./auth.constants";
import { AuthService } from "./auth.service";
import type { JwtPayload } from "./jwt-auth.guard";
import { LoginDto } from "./login.dto";
import { SignupDto } from "./signup.dto";
import { ChangePasswordDto } from "./change-password.dto";
import { Public } from "./public.decorator";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  private setCookie(res: Response, token: string) {
    res.cookie(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.get("COOKIE_SECURE") === "true",
      path: "/",
      // Pas de maxAge : cookie de session ; l'expiration réelle est celle du JWT (JWT_EXPIRES_IN).
    });
  }

  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Post("login")
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, user } = await this.auth.login(dto.username, dto.password);
    this.setCookie(res, token);
    return { user };
  }

  /** Création d'un compte client (client + premier administrateur) ; ouvre directement la session. */
  @Public()
  @UseGuards(AuthThrottlerGuard)
  // Inscription : 3 créations de compte client par heure et par IP.
  @Throttle({ ip: { limit: 3, ttl: 60 * 60_000 } })
  @Post("signup")
  @HttpCode(201)
  async signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response) {
    const { token, user } = await this.auth.signup(dto.organization.trim(), dto.username.trim(), dto.password);
    this.setCookie(res, token);
    return { user };
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: "/" });
  }

  /** Changement du mot de passe de l'utilisateur connecté. Limité par IP comme la connexion. */
  @UseGuards(AuthThrottlerGuard)
  @Post("password")
  @HttpCode(204)
  async changePassword(@Req() req: Request & { user: JwtPayload }, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(req.user.sub, dto.currentPassword, dto.newPassword);
  }

  @Get("me")
  async me(@Req() req: Request & { user: JwtPayload }) {
    const user = await this.users.findById(req.user.sub);
    if (!user) throw new UnauthorizedException();
    return { user: { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId } };
  }
}
