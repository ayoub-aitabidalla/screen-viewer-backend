import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import { AUTH_COOKIE } from "../auth/auth.constants";
import type { JwtPayload } from "../auth/jwt-auth.guard";
import { accessHeaders } from "../sites/site-fetch";
import { checkPath, LiveService } from "./live.service";

const PATH = "/api/live/mse";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Au-delà, le navigateur ne suit plus (onglet en arrière-plan, réseau lent) : on coupe, il se reconnectera. */
const MAX_BUFFERED = 8 * 1024 * 1024;

/**
 * Direct en MSE : WebSocket navigateur ⇄ backend ⇄ go2rtc viewer du site (à travers le tunnel Cloudflare si besoin).
 * go2rtc lit le flux du poste sur le MediaMTX du site et renvoie du MP4 fragmenté (protocole go2rtc « mse »).
 * Tout passe en TCP : contrairement au WebRTC, ça traverse un tunnel Cloudflare.
 *
 * Route hors contrôleurs Nest (mise à niveau WebSocket sur le serveur HTTP) : la session est vérifiée ici,
 * avec le même cookie que le reste de l'API.
 */
@Injectable()
export class LiveMseRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(LiveMseRelay.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly jwt: JwtService,
    private readonly live: LiveService,
  ) {}

  onApplicationBootstrap() {
    const server = this.adapter.httpAdapter.getHttpServer() as Server;
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!req.url?.startsWith(PATH)) return;
      // Sans ce gestionnaire, un client qui coupe brutalement (ECONNRESET) ferait tomber tout le backend.
      socket.on("error", () => socket.destroy());
      this.accept(req, socket, head).catch((e) => this.reject(socket, 500, (e as Error).message));
    });
  }

  onModuleDestroy() {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }

  private reject(socket: Duplex, status: number, message: string) {
    if (socket.destroyed) return;
    const text = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 500: "Internal Server Error" }[status] ?? "Error";
    socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${message}`);
  }

  private async accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // Même origine uniquement (une page d'un autre site ne peut pas ouvrir ce flux avec le cookie de l'utilisateur).
    const origin = req.headers.origin;
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    if (origin && host && new URL(origin).host !== host) return this.reject(socket, 403, "Origine refusée");

    const token = new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1];
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(decodeURIComponent(token ?? ""));
      if (!payload.tenantId) throw new Error();
    } catch {
      return this.reject(socket, 401, "Session absente ou expirée");
    }

    const url = new URL(req.url ?? "", "http://local");
    const gatewayId = url.searchParams.get("gatewayId");
    let path: string;
    try {
      path = checkPath(url.searchParams.get("path") ?? "");
    } catch {
      return this.reject(socket, 400, "Nom de flux invalide");
    }
    const g = await this.live.gateway(payload.tenantId, gatewayId && UUID.test(gatewayId) ? gatewayId : undefined).catch(() => null);
    if (!g) return this.reject(socket, 400, "Passerelle introuvable");
    if (!g.viewerGo2rtcUrl) return this.reject(socket, 400, "Direct MSE indisponible : go2rtc viewer non configuré");

    // go2rtc viewer et MediaMTX sont sur le même serveur local : la source est l'adresse RTSP de MediaMTX vue de là-bas.
    const src = `${g.mediamtxRtspUrl.replace(/\/$/, "")}/${path}`;
    const upstreamUrl = `${g.viewerGo2rtcUrl.replace(/\/$/, "").replace(/^http/i, "ws")}/api/ws?src=${encodeURIComponent(src)}`;

    this.wss.handleUpgrade(req, socket, head, (client) => this.relay(client, upstreamUrl, accessHeaders(g.access), path));
  }

  private relay(client: WebSocket, upstreamUrl: string, headers: Record<string, string>, path: string) {
    const up = new WebSocket(upstreamUrl, { headers, handshakeTimeout: 15_000 });
    const pending: [Buffer, boolean][] = [];
    const closeBoth = (code = 1000, reason = "") => {
      if (client.readyState <= WebSocket.OPEN) client.close(code, reason.slice(0, 120));
      if (up.readyState <= WebSocket.OPEN) up.terminate();
    };

    // Navigateur → go2rtc : messages de négociation (texte), mis en attente tant que go2rtc n'a pas répondu.
    client.on("message", (data: Buffer, isBinary) => {
      if (up.readyState === WebSocket.OPEN) up.send(data, { binary: isBinary });
      else if (pending.length < 8) pending.push([data, isBinary]);
    });
    up.on("open", () => {
      for (const [d, b] of pending.splice(0)) up.send(d, { binary: b });
    });

    // go2rtc → navigateur : type du flux (texte), puis segments MP4 (binaire).
    up.on("message", (data: Buffer, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > MAX_BUFFERED) return closeBoth(1013, "Lecteur trop lent");
      client.send(data, { binary: isBinary });
    });

    up.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      const why =
        status === 403 ? "Accès au site refusé par Cloudflare Access" : status === 530 ? "Tunnel du site hors ligne" : `go2rtc viewer : HTTP ${status}`;
      this.log.warn(`Direct MSE ${path} : ${why}`);
      closeBoth(1011, why);
    });
    up.on("error", (e) => {
      this.log.warn(`Direct MSE ${path} : ${e.message}`);
      closeBoth(1011, "go2rtc viewer injoignable");
    });
    up.on("close", () => closeBoth());
    client.on("close", () => closeBoth());
    client.on("error", () => closeBoth());
    // La source temporaire reste dans go2rtc sans lecteur : retirée par le nettoyage périodique (DvrHistoryService),
    // pas ici, car un autre utilisateur peut regarder le même poste au même moment.
  }
}
