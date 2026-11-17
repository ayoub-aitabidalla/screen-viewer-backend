import { IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from "class-validator";

/** Adresse ISAPI : "192.168.1.64", "192.168.1.64:80", ou URL du tunnel du site "https://s-a7k2-dvr1.tondomaine.com". */
const HOST = /^([A-Za-z0-9.\-]+(:\d{1,5})?|https?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?\/?)$/;
const HOST_MSG = "host : adresse IP ou nom (port optionnel), ou URL https du tunnel du site";
/** Adresse du DVR sur le réseau local du site, sans port : "192.168.1.64". */
const LAN = /^[A-Za-z0-9.\-]+$/;
const filled = (_: unknown, v: unknown) => v !== null && v !== undefined && v !== "";

export class CreateDvrDto {
  @IsString() @Length(1, 64) name: string;
  @IsString() @Length(1, 128) @Matches(HOST, { message: HOST_MSG }) host: string;
  /** Obligatoire quand host est une URL de tunnel (contrôlé par le service). */
  @IsOptional() @ValidateIf(filled) @IsString() @Matches(LAN, { message: "lanHost : adresse IP locale du DVR, sans port" }) lanHost?: string | null;
  @IsString() @Length(1, 64) username: string;
  @IsString() @Length(1, 128) password: string;
  /** Passerelle vidéo du client dont ce DVR enregistre les postes. */
  @IsUUID() gatewayId: string;
}

/** Champs absents = inchangés. Le mot de passe n'est modifié que s'il est fourni. */
export class UpdateDvrDto {
  @IsOptional() @IsString() @Length(1, 64) name?: string;
  @IsOptional() @IsString() @Length(1, 128) @Matches(HOST, { message: HOST_MSG }) host?: string;
  /** Vide = aucune (host sert d'adresse LAN). */
  @IsOptional() @ValidateIf(filled) @IsString() @Matches(LAN, { message: "lanHost : adresse IP locale du DVR, sans port" }) lanHost?: string | null;
  @IsOptional() @IsString() @Length(1, 64) username?: string;
  @IsOptional() @IsString() @Length(1, 128) password?: string;
  /** Changer de passerelle n'est possible que si le DVR n'a aucun poste enregistré. */
  @IsOptional() @IsUUID() gatewayId?: string;
}
