import { spawn } from "child_process";
import { createWriteStream, promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { DvrClient } from "../nvr/dvr.client";

/**
 * Export MP4 d'une plage d'enregistrement du DVR.
 * Le DVR ne sait télécharger que des segments entiers (/ISAPI/ContentMgmt/download, à la vitesse du disque,
 * format propriétaire Hikvision « IMKH ») : on télécharge les segments qui couvrent la plage, puis ffmpeg
 * les assemble et découpe la plage demandée sans réencodage (copie vidéo ; l'audio G.711 n'est pas gardé).
 */
/** Avancement d'un export : téléchargement des segments depuis le DVR, puis découpe par ffmpeg. */
export interface ExportProgress {
  phase: "download" | "convert";
  /** Octets reçus du DVR / octets attendus (taille annoncée dans les URI des segments, 0 si inconnue). */
  bytes: number;
  totalBytes: number;
  /** Segment en cours (1-based) / nombre de segments. */
  segment: number;
  segments: number;
}

/** Taille d'un segment annoncée par le DVR dans son playbackURI (« …&size=241230692 »), 0 si absente. */
const sizeOf = (uri: string) => Number(/[?&](?:amp;)?size=(\d+)/.exec(uri)?.[1] ?? 0);

export async function exportRange(
  dvr: DvrClient,
  segments: { playbackUri: string; startMs: number }[],
  fromMs: number,
  durationSec: number,
  opts: { onProgress?: (p: ExportProgress) => void; signal?: AbortSignal } = {},
): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "dvr-export-"));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const totalBytes = segments.reduce((a, s) => a + sizeOf(s.playbackUri), 0);
  let bytes = 0;
  const report = (phase: ExportProgress["phase"], segment: number) =>
    opts.onProgress?.({ phase, bytes, totalBytes, segment, segments: segments.length });
  try {
    const parts: string[] = [];
    for (const [i, s] of segments.entries()) {
      opts.signal?.throwIfAborted();
      const part = join(dir, `part${i}.bin`);
      report("download", i + 1);
      const body = Readable.fromWeb((await dvr.downloadSegment(s.playbackUri)) as never);
      let last = 0;
      body.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        // Pas plus d'une mise à jour toutes les 500 ms.
        const now = Date.now();
        if (now - last > 500) {
          last = now;
          report("download", i + 1);
        }
      });
      await pipeline(body, createWriteStream(part), { signal: opts.signal });
      parts.push(part);
    }
    report("convert", segments.length);
    const list = join(dir, "list.txt");
    await fs.writeFile(list, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
    const out = join(dir, "export.mp4");
    const offset = Math.max(0, (fromMs - segments[0].startMs) / 1000);
    await ffmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", list,
      "-ss", offset.toFixed(2), "-t", durationSec.toFixed(2),
      "-map", "0:v:0", "-c:v", "copy", "-an",
      "-movflags", "+faststart", "-y", out,
    ], opts.signal);
    return { file: out, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/** Lance ffmpeg (FFMPEG_PATH du .env, sinon celui du PATH). */
function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { windowsHide: true, signal });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("error", (e) => reject(new Error(`ffmpeg introuvable (installez-le ou renseignez FFMPEG_PATH) : ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg a échoué (code ${code}) : ${err.trim()}`))));
  });
}
