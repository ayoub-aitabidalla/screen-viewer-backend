/**
 * Sonde de l'historique DVR (lecture seule) : pistes d'enregistrement, heure du DVR, recherche des enregistrements.
 *   npm run dvr:history -- [canal] [jours]   (défaut : canal 5, 2 derniers jours)
 * Utilise DVR_HOST / DVR_USER / DVR_PASSWORD du .env.
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import { DigestFetch } from "../nvr/digest";

async function main() {
  const host = process.env.DVR_HOST!;
  const http = new DigestFetch(process.env.DVR_USER!, process.env.DVR_PASSWORD!);
  const channel = Number(process.argv[2] ?? 5);
  const days = Number(process.argv[3] ?? 2);
  const call = async (method: string, path: string, body?: string) => {
    const r = await http.fetch(`http://${host}${path}`, {
      method,
      body,
      headers: body ? { "Content-Type": "application/xml; charset=UTF-8" } : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return `HTTP ${r.status}\n${await r.text()}`;
  };
  const cut = (s: string, n = 2500) => (s.length > n ? s.slice(0, n) + `\n… (${s.length} caractères)` : s);

  console.log("== Heure du DVR ==");
  console.log(cut(await call("GET", "/ISAPI/System/time")));

  console.log("\n== Pistes d'enregistrement ==");
  const tracks = await call("GET", "/ISAPI/ContentMgmt/record/tracks");
  const ids = [...tracks.matchAll(/<id>(\d+)<\/id>/g)].map((m) => m[1]);
  console.log(tracks.split("\n")[0], "→ ids :", ids.join(", ") || "(aucun)");

  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
  for (const trackID of [`${channel}01`, ...ids.filter((i) => i.startsWith(String(channel)) && i !== `${channel}01`)]) {
    console.log(`\n== Recherche piste ${trackID} (${iso(start)} → ${iso(end)}) ==`);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><CMSearchDescription><searchID>${randomUUID()}</searchID>` +
      `<trackList><trackID>${trackID}</trackID></trackList>` +
      `<timeSpanList><timeSpan><startTime>${iso(start)}</startTime><endTime>${iso(end)}</endTime></timeSpan></timeSpanList>` +
      `<maxResults>20</maxResults><searchResultPostion>0</searchResultPostion>` +
      `<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`;
    // Masque le mot de passe s'il apparaissait dans une URI.
    console.log(cut((await call("POST", "/ISAPI/ContentMgmt/search", xml)).replace(/\/\/[^:@/]+:[^@/]+@/g, "//***:***@"), 4000));
  }
}

main().catch((e) => {
  console.error("ERREUR :", e.message);
  process.exit(1);
});
