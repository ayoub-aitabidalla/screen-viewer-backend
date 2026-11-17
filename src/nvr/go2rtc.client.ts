import { cloudflareError, type FetchFn } from "../sites/site-fetch";

/**
 * Client de l'API HTTP go2rtc. go2rtc sert de « caméra ONVIF » pour le DVR : chaque flux déclaré
 * devient un profil ONVIF, que le DVR sélectionne par sa position (srcInputPort = position + 1).
 */
export class Go2rtcClient {
  constructor(
    private readonly baseUrl: string, // ex. "http://127.0.0.1:1984" ou "https://s-a7k2-go2rtc.tondomaine.com"
    private readonly timeoutMs = 5000,
    /** fetch utilisé (siteFetch du site pour passer par son tunnel Cloudflare). */
    private readonly doFetch: FetchFn = (u, i) => fetch(u, i),
  ) {}

  private url(path: string) {
    return this.baseUrl.replace(/\/$/, "") + path;
  }

  private async call(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.doFetch(this.url(path), { ...init, method, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new Error(`go2rtc injoignable (${this.baseUrl}) : ${(e as Error).message}`);
    }
    const cf = cloudflareError(res);
    if (cf) throw new Error(`go2rtc (${this.baseUrl}) : ${cf}`);
    if (!res.ok) throw new Error(`go2rtc a refusé ${method} ${path} : HTTP ${res.status} ${await res.text()}`);
    return res;
  }

  /** Flux go2rtc → URL source (celle du premier producteur, si connue). */
  async streams(): Promise<Map<string, string | null>> {
    const data = (await (await this.call("GET", "/api/streams")).json()) as Record<string, { producers?: { url?: string }[] }> | null;
    return new Map(Object.entries(data ?? {}).map(([k, v]) => [k, v?.producers?.[0]?.url ?? null]));
  }

  async listStreams(): Promise<string[]> {
    return [...(await this.streams()).keys()];
  }

  /** Crée ou remplace un flux (go2rtc l'enregistre aussi dans go2rtc.yaml). */
  async putStream(name: string, src: string): Promise<void> {
    await this.call("PUT", `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`);
  }

  async deleteStream(name: string): Promise<void> {
    await this.call("DELETE", `/api/streams?src=${encodeURIComponent(name)}`);
  }

  /**
   * Ordre des profils ONVIF tel que le DVR le voit. srcInputPort d'un canal = index + 1.
   * La réponse contient aussi des noms de sous-configurations (VSC, VEC…) : on ne garde que les flux connus.
   */
  async onvifProfileOrder(): Promise<string[]> {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
      '<s:Body><GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/></s:Body></s:Envelope>';
    const [res, known] = await Promise.all([
      this.call("POST", "/onvif/media_service", { headers: { "Content-Type": "application/soap+xml" }, body }),
      this.listStreams(),
    ]);
    const text = await res.text();
    const names = [...text.matchAll(/<(?:\w+:)?Name>([^<]*)<\/(?:\w+:)?Name>/g)].map((m) => m[1]);
    const set = new Set(known);
    return [...new Set(names.filter((n) => set.has(n)))];
  }
}
