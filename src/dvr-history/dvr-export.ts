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
export async function exportRange(
  dvr: DvrClient,
  segments: { playbackUri: string; startMs: number }[],
  fromMs: number,
  durationSec: number,
): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "dvr-export-"));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  try {
    const parts: string[] = [];
    for (const [i, s] of segments.entries()) {
      const part = join(dir, `part${i}.bin`);
      const body = await dvr.downloadSegment(s.playbackUri);
      await pipeline(Readable.fromWeb(body as never), createWriteStream(part));
      parts.push(part);
    }
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
    ]);
    return { file: out, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/** Lance ffmpeg (FFMPEG_PATH du .env, sinon celui du PATH). */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("error", (e) => reject(new Error(`ffmpeg introuvable (installez-le ou renseignez FFMPEG_PATH) : ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg a échoué (code ${code}) : ${err.trim()}`))));
  });
}
