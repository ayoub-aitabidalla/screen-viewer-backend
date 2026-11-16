import { IsInt, IsOptional, IsString, IsUrl, Length, Matches, Max, Min, ValidateIf } from "class-validator";

const HTTP = { require_tld: false, require_protocol: true, protocols: ["http", "https"] };
const RTSP = { require_tld: false, require_protocol: true, protocols: ["rtsp", "rtsps"] };
const HOST = /^[A-Za-z0-9.\-]+$/;
/** recordingsDir vide ou null = pas de scan disque : on ne valide que s'il est renseigné. */
const filled = (_: unknown, v: unknown) => v !== null && v !== undefined && v !== "";

export class CreateGatewayDto {
  @IsString() @Length(1, 64) name: string;
  @IsUrl(HTTP) mediamtxApiUrl: string;
  @IsUrl(HTTP) mediamtxWebrtcUrl: string;
  @IsUrl(HTTP) mediamtxPlaybackUrl: string;
  @IsUrl(RTSP) mediamtxRtspUrl: string;
  @IsOptional() @ValidateIf(filled) @IsString() @Length(1, 512) recordingsDir?: string | null;
  @IsUrl(HTTP) go2rtcUrl: string;
  @IsString() @Matches(HOST, { message: "onvifHost : adresse IP ou nom, sans port" }) onvifHost: string;
  @IsInt() @Min(1) @Max(65535) onvifPort: number;
  @IsString() @Length(1, 64) onvifUser: string;
  @IsString() @Length(8, 16, { message: "onvifPassword : 8 à 16 caractères (exigence du DVR)" }) onvifPassword: string;
}

/** Champs absents = inchangés ; le mot de passe ONVIF n'est modifié que s'il est fourni. */
export class UpdateGatewayDto {
  @IsOptional() @IsString() @Length(1, 64) name?: string;
  @IsOptional() @IsUrl(HTTP) mediamtxApiUrl?: string;
  @IsOptional() @IsUrl(HTTP) mediamtxWebrtcUrl?: string;
  @IsOptional() @IsUrl(HTTP) mediamtxPlaybackUrl?: string;
  @IsOptional() @IsUrl(RTSP) mediamtxRtspUrl?: string;
  @IsOptional() @ValidateIf(filled) @IsString() @Length(1, 512) recordingsDir?: string | null;
  @IsOptional() @IsUrl(HTTP) go2rtcUrl?: string;
  @IsOptional() @IsString() @Matches(HOST) onvifHost?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) onvifPort?: number;
  @IsOptional() @IsString() @Length(1, 64) onvifUser?: string;
  @IsOptional() @IsString() @Length(8, 16) onvifPassword?: string;
}
