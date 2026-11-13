/**
 * Sonde DVR + go2rtc (lecture seule par défaut).
 *   npm run dvr:probe                         → infos DVR, canaux, statuts, flux go2rtc, profils ONVIF
 *   npm run dvr:probe -- --add <flux> <id>    → test d'écriture : crée le canal <id> vers le flux go2rtc <flux>
 *   npm run dvr:probe -- --remove <id>        → retire le canal <id> (les enregistrements restent sur le DVR)
 */
import "dotenv/config";
import { DvrClient } from "../nvr/dvr.client";
import { Go2rtcClient } from "../nvr/go2rtc.client";
import { nvrSettings } from "../nvr/nvr.settings";

async function onvifProfiles(go2rtcUrl: string): Promise<string[]> {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    '<s:Body><GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/></s:Body></s:Envelope>';
  const res = await fetch(go2rtcUrl.replace(/\/$/, "") + "/onvif/media_service", {
    method: "POST",
    headers: { "Content-Type": "application/soap+xml" },
    body,
  });
  const text = await res.text();
  return [...text.matchAll(/<(?:\w+:)?Name>([^<]*)<\/(?:\w+:)?Name>/g)].map((m) => m[1]);
}

async function main() {
  const s = nvrSettings();
  const dvr = new DvrClient({ host: s.dvrHost, user: s.dvrUser, password: s.dvrPassword });
  const go2rtc = new Go2rtcClient(s.go2rtcUrl);
  const [cmd, a1, a2] = process.argv.slice(2);

  if (cmd === "--add") {
    if (!a1 || !a2) throw new Error("usage : --add <flux> <id>");
    const streams = await go2rtc.listStreams();
    const idx = streams.indexOf(a1);
    if (idx < 0) throw new Error(`flux go2rtc "${a1}" introuvable (${streams.join(", ") || "aucun"})`);
    await dvr.addChannel({
      id: Number(a2),
      name: a1,
      ipAddress: s.go2rtcOnvifHost,
      port: s.go2rtcOnvifPort,
      srcInputPort: idx + 1,
      userName: s.go2rtcOnvifUser,
      password: s.go2rtcOnvifPassword,
    });
    console.log(`Canal ${a2} créé (srcInputPort=${idx + 1}). Attendez ~10 s puis relancez la sonde.`);
    return;
  }
  if (cmd === "--remove") {
    await dvr.deleteChannel(Number(a1));
    console.log(`Canal ${a1} retiré.`);
    return;
  }

  console.log("== DVR ==");
  console.log(await dvr.deviceInfo());
  const [channels, status] = await Promise.all([dvr.listChannels(), dvr.channelStatus().catch((e) => (console.warn("statut :", e.message), []))]);
  console.table(
    channels.map((c) => ({ ...c, online: status.find((x) => x.id === c.id)?.online, detail: status.find((x) => x.id === c.id)?.detail })),
  );
  console.log("== go2rtc : flux (ordre API) ==");
  console.log(await go2rtc.listStreams());
  console.log("== go2rtc : profils ONVIF (ordre vu par le DVR → srcInputPort = position) ==");
  console.log(await onvifProfiles(s.go2rtcUrl).catch((e) => `échec : ${e.message}`));
}

main().catch((e) => {
  console.error("ERREUR :", e.message);
  if (e.raw) console.error(e.raw);
  process.exit(1);
});
