
/** Signature de fetch, injectée dans DigestFetch, DvrClient, Go2rtcClient… */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Jeton de service Cloudflare Access d'un site (secret déchiffré). Les deux à null = site local. */
export interface SiteAccess {
  accessClientId: string | null;
  accessClientSecret: string | null;
}

export const NO_ACCESS: SiteAccess = { accessClientId: null, accessClientSecret: null };

/** En-têtes Cloudflare Access d'un site (vide pour un site local). Sert aussi pour les WebSocket (direct en MSE). */
export function accessHeaders(access: SiteAccess | null | undefined): Record<string, string> {
  if (!access?.accessClientId || !access.accessClientSecret) return {};
  return { "CF-Access-Client-Id": access.accessClientId, "CF-Access-Client-Secret": access.accessClientSecret };
}

/** fetch vers un service du site, avec le jeton Access s'il y en a un. */
export function siteFetch(access: SiteAccess | null | undefined, url: string, init: RequestInit = {}): Promise<Response> {
  const extra = accessHeaders(access);
  if (!Object.keys(extra).length) return fetch(url, init);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  // redirect manual : une redirection Cloudflare (page de connexion Access) doit apparaître comme une erreur,
  // pas être suivie en silence vers une page HTML.
  return fetch(url, { redirect: "manual", ...init, headers });
}

/** Version « fonction » de siteFetch, liée à un site, à passer aux clients DVR / go2rtc. */
export const siteFetcher =
  (access: SiteAccess | null | undefined): FetchFn =>
  (url, init) =>
    siteFetch(access, url, init);

/**
 * Explique une réponse refusée par Cloudflare (jeton absent ou faux, tunnel hors ligne), ou null si elle vient du site.
 * À utiliser dans les messages d'erreur pour distinguer « le DVR refuse » de « le site est injoignable ».
 */
export function cloudflareError(res: Response): string | null {
  const fromCf = !!res.headers.get("cf-ray");
  if (!fromCf) return null;
  if (res.status === 403 || (res.status >= 300 && res.status < 400 && /cloudflareaccess/.test(res.headers.get("location") ?? "")))
    return "Accès au site refusé par Cloudflare Access (jeton de service absent ou invalide)";
  // 530 : erreur Cloudflare 1033 (aucun connecteur cloudflared en ligne pour ce tunnel).
  if (res.status === 530) return "Site injoignable : le tunnel cloudflared du serveur local est hors ligne";
  return null;
}
