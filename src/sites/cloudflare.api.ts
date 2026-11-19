/**
 * Client minimal de l'API Cloudflare (v4) pour créer les sites clients sans passer par le tableau de bord :
 * tunnel cloudflared géré à distance, enregistrements DNS, jeton de service et application Access.
 *
 * Configuration (.env) — fonctionnalité désactivée si l'un manque :
 *   CF_API_TOKEN  jeton API avec les droits : Compte › Cloudflare Tunnel (modifier), Compte › Access : apps et
 *                 stratégies (modifier), Compte › Access : jetons de service (modifier), Zone › DNS (modifier)
 *   CF_ACCOUNT_ID identifiant du compte Cloudflare
 *   CF_ZONE_ID    identifiant de la zone du domaine
 *   CF_DOMAIN     domaine sous lequel les noms des sites sont créés, ex. "domaine.com"
 */
export interface CloudflareConfig {
  token: string;
  accountId: string;
  zoneId: string;
  domain: string;
}

export function cloudflareConfig(env: NodeJS.ProcessEnv = process.env): CloudflareConfig | null {
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CF_DOMAIN } = env;
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_ZONE_ID || !CF_DOMAIN) return null;
  return { token: CF_API_TOKEN, accountId: CF_ACCOUNT_ID, zoneId: CF_ZONE_ID, domain: CF_DOMAIN.replace(/^\.+|\.+$/g, "") };
}

/** Règle d'entrée du tunnel : nom public → service local du serveur du site. */
export interface IngressRule {
  hostname: string;
  service: string;
}

export class CloudflareApi {
  constructor(private readonly cfg: CloudflareConfig) {}

  get domain() {
    return this.cfg.domain;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] }
      | null;
    if (!res.ok || !data?.success) {
      const msg = data?.errors?.map((e) => `${e.message ?? "?"}${e.code ? ` (${e.code})` : ""}`).join(" · ");
      throw new Error(`Cloudflare ${method} ${path.split("/").slice(0, 4).join("/")}… : ${msg || `HTTP ${res.status}`}`);
    }
    return data.result as T;
  }

  private acc(p: string) {
    return `/accounts/${this.cfg.accountId}${p}`;
  }

  /** Tunnel dont la configuration est gérée à distance (par l'API), comme ceux créés dans le tableau de bord. */
  async createTunnel(name: string): Promise<{ id: string; token: string }> {
    const t = await this.call<{ id: string; token?: string }>("POST", this.acc("/cfd_tunnel"), { name, config_src: "cloudflare" });
    const token = t.token ?? (await this.call<string>("GET", this.acc(`/cfd_tunnel/${t.id}/token`)));
    return { id: t.id, token };
  }

  /** Remplace les règles d'entrée du tunnel (la dernière règle, obligatoire, répond 404). */
  async setIngress(tunnelId: string, rules: IngressRule[]): Promise<void> {
    await this.call("PUT", this.acc(`/cfd_tunnel/${tunnelId}/configurations`), {
      config: { ingress: [...rules, { service: "http_status:404" }] },
    });
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    // Coupe d'abord les connexions encore ouvertes, sinon la suppression est refusée.
    await this.call("DELETE", this.acc(`/cfd_tunnel/${tunnelId}/connections`)).catch(() => undefined);
    await this.call("DELETE", this.acc(`/cfd_tunnel/${tunnelId}`));
  }

  /** CNAME proxifié vers le tunnel : c'est ce qui « lie » le nom au domaine. */
  async createTunnelDns(hostname: string, tunnelId: string): Promise<string> {
    const r = await this.call<{ id: string }>("POST", `/zones/${this.cfg.zoneId}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      comment: "ScreenViewer (site créé automatiquement)",
    });
    return r.id;
  }

  async deleteDns(id: string): Promise<void> {
    await this.call("DELETE", `/zones/${this.cfg.zoneId}/dns_records/${id}`);
  }

  async createServiceToken(name: string): Promise<{ id: string; clientId: string; clientSecret: string }> {
    const r = await this.call<{ id: string; client_id: string; client_secret: string }>(
      "POST",
      this.acc("/access/service_tokens"),
      { name, duration: "8760h" },
    );
    return { id: r.id, clientId: r.client_id, clientSecret: r.client_secret };
  }

  async deleteServiceToken(id: string): Promise<void> {
    await this.call("DELETE", this.acc(`/access/service_tokens/${id}`));
  }

  /** Stratégie réutilisable : seul ce jeton de service passe. */
  async createServiceTokenPolicy(name: string, serviceTokenId: string): Promise<string> {
    const r = await this.call<{ id: string }>("POST", this.acc("/access/policies"), {
      name,
      decision: "non_identity",
      include: [{ service_token: { token_id: serviceTokenId } }],
    });
    return r.id;
  }

  async deletePolicy(id: string): Promise<void> {
    await this.call("DELETE", this.acc(`/access/policies/${id}`));
  }

  /** Application Access couvrant tous les noms du site, protégée par la stratégie donnée. */
  async createAccessApp(name: string, hostnames: string[], policyId: string): Promise<string> {
    const r = await this.call<{ id: string }>("POST", this.acc("/access/apps"), {
      name,
      type: "self_hosted",
      domain: hostnames[0],
      destinations: hostnames.map((uri) => ({ type: "public", uri })),
      session_duration: "24h",
      app_launcher_visible: false,
      policies: [{ id: policyId, precedence: 1 }],
    });
    return r.id;
  }

  async deleteAccessApp(id: string): Promise<void> {
    await this.call("DELETE", this.acc(`/access/apps/${id}`));
  }
}
