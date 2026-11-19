import { cloudflareError, type FetchFn } from "../sites/site-fetch";

/** Un écran connu de ScreenGateway, avec son go2rtc dédié (un seul profil ONVIF, port fixe). */
export interface GatewayScreen {
  slot: number;
  /** Chemin MediaMTX, ex. "desktop-ql3bupt/0". */
  path: string;
  label: string;
  online: boolean;
  /** Port ONVIF de son go2rtc : le canal du DVR pointe vers onvifHost:onvifPort, profil 1. */
  onvifPort: number;
}

/**
 * Client de l'API lecture seule de ScreenGateway pour ScreenViewer (GET /api/viewer/cameras), authentifié par
 * la clé générée sur sa page d'administration (en-tête X-ScreenGateway-Key).
 */
export class ScreenGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly doFetch: FetchFn = fetch,
    private readonly timeoutMs = 8000,
  ) {}

  async screens(): Promise<GatewayScreen[]> {
    const res = await this.doFetch(`${this.baseUrl.replace(/\/$/, "")}/api/viewer/cameras`, {
      headers: { "X-ScreenGateway-Key": this.key },
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((e: Error) => {
      throw new Error(`ScreenGateway injoignable : ${e.message}`);
    });
    const cf = cloudflareError(res);
    if (cf) throw new Error(cf);
    if (res.status === 401) throw new Error("ScreenGateway : clé refusée (générez-en une sur sa page et reportez-la dans la passerelle)");
    if (!res.ok) throw new Error(`ScreenGateway : HTTP ${res.status}`);
    const body = (await res.json()) as { cameras?: GatewayScreen[] };
    return body.cameras ?? [];
  }
}
