import { ConflictException, GoneException, Injectable, Logger, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DvrError } from "../nvr/dvr.client";
import { exportRange, type ExportProgress } from "./dvr-export";
import { DvrHistoryService } from "./dvr-history.service";

export type ExportStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

/** Ce que le viewer voit d'une tâche d'export. */
export interface ExportView {
  id: string;
  cameraId: string;
  name: string;
  status: ExportStatus;
  /** 0 à 100 ; null tant que la taille totale est inconnue. */
  percent: number | null;
  phase: ExportProgress["phase"] | null;
  segment: number;
  segments: number;
  error: string | null;
  createdAt: string;
  /** Après cette date, le fichier prêt est supprimé. */
  expiresAt: string | null;
}

interface Job extends ExportView {
  tenantId: string;
  file: string | null;
  cleanup: (() => Promise<void>) | null;
  ctrl: AbortController;
  run: () => Promise<void>;
}

/** Préparations en parallèle (chacune télécharge des centaines de Mo depuis un DVR). */
const MAX_RUNNING = 2;
/** Tâches non terminées par client (en attente + en cours). */
const MAX_ACTIVE_PER_TENANT = 3;
/** Durée de conservation d'un fichier prêt mais pas récupéré. */
const KEEP_MS = 30 * 60_000;
/** Durée de conservation de l'état d'une tâche échouée ou annulée. */
const KEEP_FAILED_MS = 10 * 60_000;

/**
 * Téléchargements MP4 en tâche de fond : le viewer lance l'export, suit sa progression, puis récupère le fichier.
 * Aucune requête HTTP n'attend la préparation, qui peut durer plusieurs minutes : indispensable derrière
 * Cloudflare (réponse coupée au-delà de 100 s). État en mémoire : les tâches en cours sont perdues au redémarrage.
 */
@Injectable()
export class DvrExportsService implements OnModuleDestroy {
  private readonly log = new Logger(DvrExportsService.name);
  private readonly jobs = new Map<string, Job>();
  private running = 0;
  private readonly sweeper = setInterval(() => void this.sweep(), 60_000);

  constructor(private readonly history: DvrHistoryService) {}

  async onModuleDestroy() {
    clearInterval(this.sweeper);
    for (const j of this.jobs.values()) {
      j.ctrl.abort();
      await j.cleanup?.();
    }
  }

  /** Lance un export ; la recherche des segments est faite tout de suite (erreur immédiate si la plage est vide). */
  async start(tenantId: string, cameraId: string, startIso?: string, durationSec?: number): Promise<ExportView> {
    const active = [...this.jobs.values()].filter((j) => j.tenantId === tenantId && (j.status === "queued" || j.status === "running"));
    if (active.length >= MAX_ACTIVE_PER_TENANT)
      throw new ConflictException({ message: `${MAX_ACTIVE_PER_TENANT} téléchargements sont déjà en préparation : attendez qu'ils se terminent`, code: "tooManyExports" });

    const plan = await this.history.planExport(tenantId, cameraId, startIso, durationSec);
    const job: Job = {
      id: randomUUID(),
      tenantId,
      cameraId,
      name: plan.name,
      status: "queued",
      percent: null,
      phase: null,
      segment: 0,
      segments: plan.recs.length,
      error: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      file: null,
      cleanup: null,
      ctrl: new AbortController(),
      run: async () => {
        // Lu après chaque attente : cancel() peut avoir changé le statut entre-temps.
        const cancelled = () => (job.status as ExportStatus) === "cancelled";
        job.status = "running";
        try {
          const out = await exportRange(plan.dvr, plan.recs, plan.start, plan.durationSec, {
            signal: job.ctrl.signal,
            onProgress: (p) => {
              job.phase = p.phase;
              job.segment = p.segment;
              // Téléchargement = 0-95 %, découpe ffmpeg = 95-100 %.
              job.percent = p.phase === "convert" ? 95 : p.totalBytes ? Math.min(95, Math.round((p.bytes / p.totalBytes) * 95)) : null;
            },
          });
          if (cancelled()) return void (await out.cleanup());
          Object.assign(job, { status: "ready", percent: 100, file: out.file, cleanup: out.cleanup, expiresAt: new Date(Date.now() + KEEP_MS).toISOString() });
        } catch (e) {
          if (cancelled()) return;
          job.status = "failed";
          job.error = e instanceof DvrError || e instanceof Error ? e.message : String(e);
          job.expiresAt = new Date(Date.now() + KEEP_FAILED_MS).toISOString();
          this.log.warn(`Export ${job.name} échoué : ${job.error}`);
        }
      },
    };
    this.jobs.set(job.id, job);
    this.pump();
    return this.view(job);
  }

  /** Démarre les tâches en attente, dans la limite de MAX_RUNNING. */
  private pump() {
    for (const j of this.jobs.values()) {
      if (this.running >= MAX_RUNNING) return;
      if (j.status !== "queued") continue;
      this.running++;
      void j.run().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private job(tenantId: string, id: string): Job {
    const j = this.jobs.get(id);
    // Une tâche d'un autre client est traitée comme inexistante.
    if (!j || j.tenantId !== tenantId) throw new NotFoundException({ message: "Téléchargement introuvable ou expiré", code: null });
    return j;
  }

  get(tenantId: string, id: string): ExportView {
    return this.view(this.job(tenantId, id));
  }

  /** Fichier prêt, pour l'envoyer ; il est supprimé dès l'envoi terminé (done). */
  file(tenantId: string, id: string): { path: string; name: string; done: () => void } {
    const j = this.job(tenantId, id);
    if (j.status !== "ready" || !j.file) throw new GoneException({ message: "Le fichier n'est pas prêt ou n'est plus disponible", code: "exportNotReady" });
    return {
      path: j.file,
      name: j.name,
      done: () => {
        void j.cleanup?.();
        this.jobs.delete(j.id);
      },
    };
  }

  /** Annule une préparation en cours, ou supprime un fichier prêt non récupéré. */
  async cancel(tenantId: string, id: string): Promise<void> {
    const j = this.job(tenantId, id);
    j.status = "cancelled";
    j.ctrl.abort();
    await j.cleanup?.();
    this.jobs.delete(j.id);
  }

  /** Supprime les fichiers prêts expirés et l'état des tâches terminées depuis longtemps. */
  private async sweep() {
    const now = Date.now();
    for (const j of [...this.jobs.values()]) {
      if (!j.expiresAt || Date.parse(j.expiresAt) > now) continue;
      await j.cleanup?.();
      this.jobs.delete(j.id);
    }
  }

  private view(j: Job): ExportView {
    const { id, cameraId, name, status, percent, phase, segment, segments, error, createdAt, expiresAt } = j;
    return { id, cameraId, name, status, percent, phase, segment, segments, error, createdAt, expiresAt };
  }
}
