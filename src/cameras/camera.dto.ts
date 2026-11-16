import { IsOptional, IsString, IsUUID, Length, Matches } from "class-validator";

export class CreateCameraDto {
  @IsString()
  @Length(1, 32)
  name: string;

  /** Chemin MediaMTX du flux du poste, ex. "desktop-ql3bupt/0". */
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9._~\-/]+$/, { message: "streamPath : caractères autorisés A-Z a-z 0-9 . _ ~ - /" })
  streamPath: string;

  /** DVR cible. Facultatif si le client n'a qu'un seul DVR. */
  @IsOptional()
  @IsUUID()
  dvrId?: string;
}

export class UpdateCameraDto {
  @IsString()
  @Length(1, 32)
  name: string;
}
