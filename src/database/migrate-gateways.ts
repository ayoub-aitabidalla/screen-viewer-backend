import "dotenv/config";
import { existsSync } from "fs";
import { resolve } from "path";
import { DataSource } from "typeorm";
import { dbOptions } from "./data-source";

/**
 * Migration unique : sépare la passerelle vidéo (MediaMTX + go2rtc) du DVR. Usage : npm run migrate:gateways (backend arrêté).
 *
 * Avant, chaque DVR contenait ses réglages go2rtc / MediaMTX. Désormais ils sont dans "gateways" et le DVR pointe dessus
 * (dvrs.gateway_id NOT NULL) : la synchronisation TypeORM ne peut pas faire cette transformation seule. Ce script :
 *   1. copie dvrs et cameras dans _legacy_dvrs / _legacy_cameras, puis les vide ;
 *   2. synchronise le schéma (table gateways, nouvelles colonnes de dvrs) ;
 *   3. crée une passerelle par jeu de réglages distinct (en pratique une par client), avec les mêmes mots de passe chiffrés ;
 *   4. réinsère DVR et caméras avec les mêmes id, puis supprime les tables _legacy_*.
 * Les adresses WebRTC / playback / recordings, qui n'existaient pas avant, viennent de MEDIAMTX_WEBRTC_URL,
 * MEDIAMTX_PLAYBACK_URL et RECORDINGS_DIR (.env), sinon des valeurs locales par défaut ; elles se modifient ensuite
 * dans l'onglet « Passerelles ». Relancer le script après un échec reprend à l'étape 2. Sans effet sur une base déjà migrée.
 */
async function main() {
  const ds = await new DataSource({ ...dbOptions(), synchronize: false }).initialize();
  const q = (sql: string, params?: unknown[]) => ds.query(sql, params);
  const tableExists = async (t: string) => (await q("SELECT to_regclass($1) AS r", [`public.${t}`]))[0].r !== null;
  const hasColumn = async (t: string, c: string) =>
    (await q("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [t, c])).length > 0;

  const legacyPending = await tableExists("_legacy_dvrs");
  const needsMigration = (await tableExists("dvrs")) && (await hasColumn("dvrs", "go2rtc_url"));
  if (!legacyPending && !needsMigration) {
    console.log("Passerelles déjà en place (ou base vide) : rien à migrer.");
    await ds.destroy();
    return;
  }

  // 1. Mise de côté.
  if (!legacyPending) {
    await ds.transaction(async (m) => {
      await m.query("CREATE TABLE _legacy_dvrs AS SELECT * FROM dvrs");
      await m.query("CREATE TABLE _legacy_cameras AS SELECT * FROM cameras");
      await m.query("DELETE FROM cameras");
      await m.query("DELETE FROM dvrs");
    });
    console.log("DVR et caméras copiés dans _legacy_dvrs / _legacy_cameras.");
  }

  // 2. Nouveau schéma (supprime les anciennes colonnes de dvrs, vide à ce stade).
  await ds.synchronize();

  // 3 et 4.
  const webrtc = process.env.MEDIAMTX_WEBRTC_URL ?? "http://127.0.0.1:8889";
  const playback = process.env.MEDIAMTX_PLAYBACK_URL ?? "http://127.0.0.1:9996";
  const defaultRec = resolve(process.cwd(), "..", "..", "mediamtx_v1.21.3_windows_amd64", "recordings");
  const recordingsDir = process.env.RECORDINGS_DIR ?? (existsSync(defaultRec) ? defaultRec : null);

  await ds.transaction(async (m) => {
    const dvrs: any[] = await m.query("SELECT * FROM _legacy_dvrs ORDER BY created_at");
    const made = new Map<string, string>(); // réglages identiques → même passerelle
    const perTenant = new Map<string, number>();
    for (const d of dvrs) {
      const key = [d.tenant_id, d.go2rtc_url, d.onvif_host, d.onvif_port, d.mediamtx_api_url, d.mediamtx_rtsp_url].join("|");
      let gatewayId = made.get(key);
      if (!gatewayId) {
        const n = (perTenant.get(d.tenant_id) ?? 0) + 1;
        perTenant.set(d.tenant_id, n);
        const [g] = await m.query(
          `INSERT INTO gateways (tenant_id, name, mediamtx_api_url, mediamtx_webrtc_url, mediamtx_playback_url, mediamtx_rtsp_url,
                                 recordings_dir, go2rtc_url, onvif_host, onvif_port, onvif_user, onvif_password_enc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [
            d.tenant_id, n === 1 ? "Passerelle principale" : `Passerelle ${n}`, d.mediamtx_api_url, webrtc, playback, d.mediamtx_rtsp_url,
            recordingsDir, d.go2rtc_url, d.onvif_host, d.onvif_port, d.onvif_user, d.onvif_password_enc,
          ],
        );
        gatewayId = g.id as string;
        made.set(key, gatewayId);
      }
      await m.query(
        `INSERT INTO dvrs (id, tenant_id, gateway_id, name, host, username, password_enc, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [d.id, d.tenant_id, gatewayId, d.name, d.host, d.username, d.password_enc, d.created_at, d.updated_at],
      );
    }
    const cams = await m.query(
      `INSERT INTO cameras (id, tenant_id, dvr_id, name, stream_path, go2rtc_name, dvr_channel_id, created_at, updated_at)
       SELECT id, tenant_id, dvr_id, name, stream_path, go2rtc_name, dvr_channel_id, created_at, updated_at FROM _legacy_cameras RETURNING id`,
    );
    await m.query("DROP TABLE _legacy_cameras");
    await m.query("DROP TABLE _legacy_dvrs");
    console.log(`${made.size} passerelle(s) créée(s), ${dvrs.length} DVR et ${cams.length} poste(s) enregistré(s) rattachés.`);
    console.log(`WebRTC : ${webrtc} · Playback : ${playback} · Enregistrements : ${recordingsDir ?? "non renseigné"}`);
  });
  await ds.destroy();
}

main().catch((e) => {
  console.error("ERREUR :", e.message);
  process.exit(1);
});
