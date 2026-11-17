import { createHash, randomBytes } from "node:crypto";
import type { FetchFn } from "../sites/site-fetch";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

interface Challenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

function parseChallenge(header: string): Challenge | null {
  if (!/^digest\s/i.test(header)) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  if (!out.realm || !out.nonce) return null;
  return { realm: out.realm, nonce: out.nonce, qop: out.qop, opaque: out.opaque, algorithm: out.algorithm };
}

/**
 * fetch avec authentification HTTP Digest (RFC 2617, MD5, qop=auth) — utilisée par l'ISAPI Hikvision.
 * Le challenge est mémorisé et réutilisé (nc incrémenté) pour éviter un aller-retour 401 par requête.
 */
export class DigestFetch {
  private challenge: Challenge | null = null;
  private nc = 0;

  constructor(
    private readonly user: string,
    private readonly password: string,
    /** fetch utilisé (siteFetch pour passer par le tunnel Cloudflare d'un site distant). */
    private readonly doFetch: FetchFn = (u, i) => fetch(u, i),
  ) {}

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    if (this.challenge) {
      const res = await this.send(url, init, method);
      if (res.status !== 401) return res;
      this.updateChallenge(res);
    } else {
      const res = await this.doFetch(url, init);
      if (res.status !== 401) return res;
      this.updateChallenge(res);
    }
    if (!this.challenge) throw new Error("Le DVR a refusé l'authentification (pas de challenge Digest).");
    return this.send(url, init, method);
  }

  private updateChallenge(res: Response) {
    const c = parseChallenge(res.headers.get("www-authenticate") ?? "");
    this.challenge = c;
    this.nc = 0;
  }

  private send(url: string, init: RequestInit, method: string): Promise<Response> {
    const c = this.challenge!;
    const u = new URL(url);
    const uri = u.pathname + u.search;
    const ha1 = md5(`${this.user}:${c.realm}:${this.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const qop = c.qop?.split(",").map((s) => s.trim()).includes("auth") ? "auth" : undefined;
    const nc = (++this.nc).toString(16).padStart(8, "0");
    const cnonce = randomBytes(8).toString("hex");
    const response = qop ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`);
    let auth = `Digest username="${this.user}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", response="${response}"`;
    if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (c.opaque) auth += `, opaque="${c.opaque}"`;
    if (c.algorithm) auth += `, algorithm=${c.algorithm}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", auth);
    return this.doFetch(url, { ...init, headers });
  }
}
