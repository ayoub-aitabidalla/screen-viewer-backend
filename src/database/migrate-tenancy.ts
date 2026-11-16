import "dotenv/config";
import { DataSource } from "typeorm";
import { encryptSecret } from "../common/secret-box";
import { nvrSettings } from "../nvr/nvr.settings";
import { dbOptions } from "./data-source";

/**
 * Migration unique vers le multi-client. Usage : npm run migrate:tenancy (backend arrêté).
 *
 * Une base créée avant le multi-client a des lignes dans "users" et "cameras" sans tenant_id / dvr_id :
 * la synchronisation TypeORM ne peut pas y ajouter ces colonnes NOT NULL. Ce script :
 *   1. copie users et cameras dans des tables _legacy_*, puis les vide ;
 *   2. synchronise le schéma (création de tenants, dvrs, nouvelles colonnes) ;
 *   3. crée le client SEED_TENANT et son DVR à partir des anciennes variables DVR_* / GO2RTC_* / MEDIAMTX_* du .env ;
 *   4. réinsère utilisateurs et caméras rattachés à ce client et ce DVR, puis supprime les tables _legacy_*.
 * En cas d'échec à l'étape 3 ou 4, les tables _legacy_* restent en place : relancer le script reprend à l'étape 2.
 * Sans effet sur une base déjà migrée ou vide.
 */
async function main() {
  const ds = await new DataSource({ ...dbOptions(), synchronize: false }).initialize();
  const q = (sql: string, params?: unknown[]) => ds.query(sql, params);
  const tableExists = async (t: string) => (await q("SELECT to_regclass($1) AS r", [`public.${t}`]))[0].r !== null;
  const hasColumn = async (t: string, c: string) =>
    (await q("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [t, c])).length > 0;

  // 1. Mise de côté des données d'avant le multi-client.
  const legacyPending = await tableExists("_legacy_users");
  const needsMigration = (await tableExists("users")) && !(await hasColumn("users", "tenant_id"));
  if (!legacyPending && !needsMigration) {
    console.log("Base déjà multi-client (ou vide) : rien à migrer.");
    await ds.destroy();
    return;
  }
  if (!legacyPending) {
    await ds.transaction(async (m) => {
      await m.query("CREATE TABLE _legacy_users AS SELECT * FROM users");
      await m.query((await tableExists("cameras")) ? "CREATE TABLE _legacy_cameras AS SELECT * FROM cameras" : "CREATE TABLE _legacy_cameras (id uuid)");
      if (await tableExists("cameras")) await m.query("DELETE FROM cameras");
      await m.query("DELETE FROM users");
    });
    console.log("Données existantes copiées dans _legacy_users / _legacy_cameras.");
  }

  // 2. Nouveau schéma.
  await ds.synchronize();

  // 3 et 4. Client + DVR par défaut, réinsertion.
  const tenantName = process.env.SEED_TENANT ?? "Client par défaut";
  const s = nvrSettings();
  await ds.transaction(async (m) => {
    const [tenant] = await m.query(
      "INSERT INTO tenants (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [tenantName],
    );
    const existingGw = await m.query("SELECT id FROM gateways WHERE tenant_id = $1 AND name = $2", [tenant.id, "Passerelle principale"]);
    const gatewayId: string = existingGw[0]?.id ??
      (
        await m.query(
          `INSERT INTO gateways (tenant_id, name, mediamtx_api_url, mediamtx_webrtc_url, mediamtx_playback_url, mediamtx_rtsp_url,
                                 recordings_dir, go2rtc_url, onvif_host, onvif_port, onvif_user, onvif_password_enc)
           VALUES ($1, 'Passerelle principale', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            tenant.id, s.mediamtxApiUrl, process.env.MEDIAMTX_WEBRTC_URL ?? "http://127.0.0.1:8889",
            process.env.MEDIAMTX_PLAYBACK_URL ?? "http://127.0.0.1:9996", s.mediamtxRtspUrl, process.env.RECORDINGS_DIR ?? null,
            s.go2rtcUrl, s.go2rtcOnvifHost, s.go2rtcOnvifPort, s.go2rtcOnvifUser, encryptSecret(s.go2rtcOnvifPassword),
          ],
        )
      )[0].id;
    const existing = await m.query("SELECT id FROM dvrs WHERE tenant_id = $1 AND name = $2", [tenant.id, "DVR principal"]);
    const dvrId: string = existing[0]?.id ??
      (
        await m.query(
          `INSERT INTO dvrs (tenant_id, gateway_id, name, host, username, password_enc)
           VALUES ($1, $2, 'DVR principal', $3, $4, $5) RETURNING id`,
          [tenant.id, gatewayId, s.dvrHost, s.dvrUser, encryptSecret(s.dvrPassword)],
        )
      )[0].id;

    const users = await m.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, role, created_at)
       SELECT id, $1, username, password_hash, role, created_at FROM _legacy_users ON CONFLICT (id) DO NOTHING RETURNING id`,
      [tenant.id],
    );
    const hasCams = await m.query("SELECT 1 FROM information_schema.columns WHERE table_name = '_legacy_cameras' AND column_name = 'stream_path'");
    const cams = hasCams.length
      ? await m.query(
          `INSERT INTO cameras (id, tenant_id, dvr_id, name, stream_path, go2rtc_name, dvr_channel_id, created_at, updated_at)
           SELECT id, $1, $2, name, stream_path, go2rtc_name, dvr_channel_id, created_at, updated_at FROM _legacy_cameras
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [tenant.id, dvrId],
        )
      : [];
    await m.query("DROP TABLE _legacy_users");
    await m.query("DROP TABLE _legacy_cameras");
    console.log(`Client "${tenantName}" : ${users.length} utilisateur(s), DVR principal (${s.dvrHost}), ${cams.length} caméra(s).`);
  });
  console.log("Migration terminée. Les variables DVR_* / GO2RTC_ONVIF_* du .env ne sont plus lues par le backend.");
  await ds.destroy();
}

main().catch((e) => {
  console.error("ERREUR :", e.message);
  process.exit(1);
});
