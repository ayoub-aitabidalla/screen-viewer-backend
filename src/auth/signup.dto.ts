import { IsString, Length, Matches } from "class-validator";

export class SignupDto {
  /** Nom du client (entreprise / site), unique. */
  @IsString()
  @Length(2, 64)
  organization: string;

  @IsString()
  @Length(3, 64)
  @Matches(/^[A-Za-z0-9._-]+$/, { message: "username : lettres, chiffres, . _ - uniquement" })
  username: string;

  @IsString()
  @Length(8, 128, { message: "password : 8 caractères minimum" })
  password: string;
}
