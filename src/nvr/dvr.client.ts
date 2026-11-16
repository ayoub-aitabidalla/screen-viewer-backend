import { randomUUID } from "crypto";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { DigestFetch } from "./digest";

const NS = "http://www.hikvision.com/ver20/XMLSchema";

export interface DvrConfig {
  host: string; // ex. "192.168.8.64" ou "192.168.8.64:80"
  user: string;
  password: string;
  timeoutMs?: number;
}

export interface DvrDeviceInfo {
  deviceName: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  deviceType: string;
}

export interface DvrChannel {
  id: number;
  name: string;
  protocol: string;
  ipAddress: string;
  port: number;
  srcInputPort: number;
  userName: string;
}

/** Segment enregistré, horaires en heure locale du DVR (format ISAPI). */
export interface DvrRecording {
  start: string;
  end: string;
  playbackUri: string;
}

export interface DvrChannelStatus {
  id: number;
  online: boolean;
  detail: string;
}

/** Paramètres d'un canal IP ONVIF (le mot de passe est écrit, jamais relu : le DVR ne le renvoie pas). */
export interface DvrChannelInput {
  id: number;
  name: string;
  ipAddress: string;
  port: number;
  srcInputPort: number;
  userName: string;
  password: string;
}

const SUB_STATUS_FR: Record<string, string> = {
  channelNumExceed: "nombre maximum de canaux IP atteint",
  maxIPCNumberExceeded: "nombre maximum de caméras IP atteint",
  IPCExists: "cette caméra est déjà ajoutée",
  ipAddressConflict: "adresse IP déjà utilisée par un autre canal",
  deviceBusy: "le DVR est occupé, réessayez",
  invalidOperation: "opération refusée",
  notSupport: "opération non supportée par ce DVR",
  noPermission: "droits insuffisants pour le compte du backend",
  badXmlContent: "requête invalide (contenu XML)",
  badParameters: "paramètres invalides",
  passwordLengthError: "mot de passe ONVIF invalide (8 à 16 caractères)",
};

/** Erreur renvoyée par le DVR (ResponseStatus ISAPI) ou par le transport. */
export class DvrError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly statusString?: string,
    readonly subStatusCode?: string,
    readonly raw?: string,
  ) {
    super(message);
  }
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, removeNSPrefix: true });
const builder = new XMLBuilder({ ignoreAttributes: false, format: false, suppressEmptyNode: false });

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Client ISAPI minimal pour un DVR/NVR Hikvision. */
export class DvrClient {
  private readonly http: DigestFetch;
  private readonly base: string;

  constructor(private readonly cfg: DvrConfig) {
    this.http = new DigestFetch(cfg.user, cfg.password);
    this.base = `http://${cfg.host}`;
  }

  private async request(method: string, path: string, body?: string): Promise<any> {
    let res: Response;
    try {
      res = await this.http.fetch(this.base + path, {
        method,
        body,
        headers: body ? { "Content-Type": "application/xml; charset=UTF-8" } : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 8000),
      });
    } catch (e) {
      throw new DvrError(`DVR injoignable (${this.cfg.host}) : ${(e as Error).message}`, 0);
    }
    const text = await res.text();
    const doc = text.trim().startsWith("<") ? parser.parse(text) : {};
    const rs = doc.ResponseStatus;
    const failedStatus = rs && str(rs.statusCode) !== "1" && str(rs.statusCode) !== "";
    if (!res.ok || failedStatus) {
      if (res.status === 401) throw new DvrError("Identifiants du DVR refusés", 401, undefined, undefined, text);
      const sub = str(rs?.subStatusCode);
      const statusString = str(rs?.statusString);
      const reason = SUB_STATUS_FR[sub] ?? (statusString || `HTTP ${res.status}`);
      throw new DvrError(`Le DVR a refusé l'opération : ${reason}`, res.status, statusString, sub || undefined, text);
    }
    return doc;
  }

  async deviceInfo(): Promise<DvrDeviceInfo> {
    const d = (await this.request("GET", "/ISAPI/System/deviceInfo")).DeviceInfo ?? {};
    return {
      deviceName: str(d.deviceName),
      model: str(d.model),
      serialNumber: str(d.serialNumber),
      firmwareVersion: str(d.firmwareVersion),
      deviceType: str(d.deviceType),
    };
  }

  async listChannels(): Promise<DvrChannel[]> {
    const doc = await this.request("GET", "/ISAPI/ContentMgmt/InputProxy/channels");
    return asArray<any>(doc.InputProxyChannelList?.InputProxyChannel).map((c) => {
      const s = c.sourceInputPortDescriptor ?? {};
      return {
        id: Number(c.id),
        name: str(c.name),
        protocol: str(s.proxyProtocol),
        ipAddress: str(s.ipAddress || s.hostName),
        port: Number(s.managePortNo ?? 0),
        srcInputPort: Number(s.srcInputPort ?? 1),
        userName: str(s.userName),
      };
    });
  }

  async channelStatus(): Promise<DvrChannelStatus[]> {
    const doc = await this.request("GET", "/ISAPI/ContentMgmt/InputProxy/channels/status");
    return asArray<any>(doc.InputProxyChannelStatusList?.InputProxyChannelStatus).map((c) => ({
      id: Number(c.id),
      online: str(c.online) === "true",
      detail: str(c.chanDetectResult),
    }));
  }

  private channelXml(c: DvrChannelInput): string {
    return builder.build({
      InputProxyChannel: {
        "@_version": "1.0",
        "@_xmlns": NS,
        id: c.id,
        name: c.name,
        sourceInputPortDescriptor: {
          proxyProtocol: "ONVIF",
          addressingFormatType: "ipaddress",
          ipAddress: c.ipAddress,
          managePortNo: c.port,
          srcInputPort: c.srcInputPort,
          userName: c.userName,
          password: c.password,
          streamType: "tcp",
        },
      },
    });
  }

  /**
   * Ajoute un canal IP. Attention : ce DVR choisit lui-même l'id et le nom du canal (il ignore ceux envoyés).
   * Renvoie l'id réellement attribué, déduit en comparant la liste des canaux avant/après.
   */
  async addChannel(c: DvrChannelInput): Promise<number> {
    const before = new Set((await this.listChannels()).map((x) => x.id));
    // ResponseStatus.id ne correspond pas au numéro du canal sur ce firmware : on compare la liste avant/après.
    await this.request("POST", "/ISAPI/ContentMgmt/InputProxy/channels", this.channelXml(c));
    const added = (await this.listChannels()).filter((x) => !before.has(x.id));
    if (added.length !== 1) throw new DvrError("Canal ajouté mais id attribué par le DVR introuvable", 0);
    return added[0].id;
  }

  async updateChannel(c: DvrChannelInput): Promise<void> {
    await this.request("PUT", `/ISAPI/ContentMgmt/InputProxy/channels/${c.id}`, this.channelXml(c));
  }

  /** Retire le canal IP. N'efface pas les enregistrements déjà présents sur le disque. */
  async deleteChannel(id: number): Promise<void> {
    await this.request("DELETE", `/ISAPI/ContentMgmt/InputProxy/channels/${id}`);
  }

  /**
   * Décalage de l'horloge du DVR par rapport à UTC, en minutes (ex. +60 pour GMT+01:00), lu dans localTime.
   * Les horaires de recherche et de relecture ISAPI sont en heure locale du DVR, même s'ils portent un « Z ».
   */
  async utcOffsetMinutes(): Promise<number> {
    const t = str((await this.request("GET", "/ISAPI/System/time")).Time?.localTime);
    const m = /([+-])(\d{2}):?(\d{2})$/.exec(t);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  }

  /**
   * Enregistrements d'une piste (canal × 100 + 1) entre deux horaires « locaux DVR » au format ISAPI (YYYY-MM-DDTHH:mm:ssZ).
   * Parcourt toutes les pages de résultats (le DVR répond « MORE » tant qu'il en reste).
   */
  async searchRecordings(trackId: number, startLocal: string, endLocal: string, max = 2000): Promise<DvrRecording[]> {
    const out: DvrRecording[] = [];
    const searchID = randomUUID();
    for (let pos = 0; pos < max; ) {
      const xml = builder.build({
        CMSearchDescription: {
          "@_version": "1.0",
          "@_xmlns": NS,
          searchID,
          trackList: { trackID: trackId },
          timeSpanList: { timeSpan: { startTime: startLocal, endTime: endLocal } },
          maxResults: 50,
          searchResultPostion: pos, // orthographe de l'ISAPI Hikvision
          metadataList: { metadataDescriptor: "//recordType.meta.std-cgi.com" },
        },
      });
      const r = (await this.request("POST", "/ISAPI/ContentMgmt/search", xml)).CMSearchResult ?? {};
      const items = asArray<any>(r.matchList?.searchMatchItem);
      for (const it of items)
        out.push({
          start: str(it.timeSpan?.startTime),
          end: str(it.timeSpan?.endTime),
          playbackUri: str(it.mediaSegmentDescriptor?.playbackURI),
        });
      if (str(r.responseStatusStrg) !== "MORE" || items.length === 0) break;
      pos += items.length;
    }
    return out;
  }

  /**
   * Télécharge un segment entier (playbackURI renvoyé par searchRecordings) à la vitesse du disque.
   * Le DVR refuse les plages arbitraires : seule l'URI exacte d'un segment fonctionne. Format renvoyé : Hikvision « IMKH ».
   */
  async downloadSegment(playbackUri: string): Promise<ReadableStream<Uint8Array>> {
    const esc = playbackUri.replace(/&(?!amp;)/g, "&amp;");
    const body = `<?xml version="1.0" encoding="UTF-8"?><downloadRequest version="1.0" xmlns="${NS}"><playbackURI>${esc}</playbackURI></downloadRequest>`;
    let res: Response;
    try {
      res = await this.http.fetch(this.base + "/ISAPI/ContentMgmt/download", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/xml; charset=UTF-8" },
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (e) {
      throw new DvrError(`DVR injoignable (${this.cfg.host}) : ${(e as Error).message}`, 0);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || type.includes("xml")) {
      const text = await res.text().catch(() => "");
      throw new DvrError(`Le DVR a refusé le téléchargement (HTTP ${res.status})`, res.status, undefined, undefined, text);
    }
    return res.body as ReadableStream<Uint8Array>;
  }

  /** URL RTSP de relecture avec identifiants, à usage interne (go2rtc) : ne jamais la renvoyer au navigateur. */
  playbackRtspUrl(trackId: number, startLocalCompact: string, endLocalCompact?: string, rtspPort = 554): string {
    const host = this.cfg.host.replace(/:\d+$/, "");
    const cred = `${encodeURIComponent(this.cfg.user)}:${encodeURIComponent(this.cfg.password)}`;
    const q = `starttime=${startLocalCompact}${endLocalCompact ? `&endtime=${endLocalCompact}` : ""}`;
    return `rtsp://${cred}@${host}:${rtspPort}/Streaming/tracks/${trackId}/?${q}`;
  }
}
