import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Chiffrement des secrets stockés en base (mots de passe DVR / ONVIF) : AES-256-GCM.
 * Clé dérivée de SECRETS_KEY (.env). Format stocké : "v1:<iv>:<tag>:<données>" en base64.
 * Changer SECRETS_KEY rend les secrets existants illisibles : ils devront être ressaisis.
 */
function key(): Buffer {
  const k = process.env.SECRETS_KEY;
  if (!k || k.length < 32) throw new Error("SECRETS_KEY manquant ou trop court dans .env (32 caractères minimum)");
  return createHash("sha256").update(k).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, data] = stored.split(":");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("Secret chiffré illisible");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
