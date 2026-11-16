import { IsOptional, IsString, IsUUID, Length, Matches } from "class-validator";

const HOST = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/;

export class CreateDvrDto {
  @IsString() @Length(1, 64) name: string;
  @IsString() @Matches(HOST, { message: "host : adresse IP ou nom, port optionnel (ex. 192.168.1.64:80)" }) host: string;
  @IsString() @Length(1, 64) username: string;
  @IsString() @Length(1, 128) password: string;
  /** Passerelle vidéo du client dont ce DVR enregistre les postes. */
  @IsUUID() gatewayId: string;
}

/** Champs absents = inchangés. Le mot de passe n'est modifié que s'il est fourni. */
export class UpdateDvrDto {
  @IsOptional() @IsString() @Length(1, 64) name?: string;
  @IsOptional() @IsString() @Matches(HOST) host?: string;
  @IsOptional() @IsString() @Length(1, 64) username?: string;
  @IsOptional() @IsString() @Length(1, 128) password?: string;
  /** Changer de passerelle n'est possible que si le DVR n'a aucun poste enregistré. */
  @IsOptional() @IsUUID() gatewayId?: string;
}
