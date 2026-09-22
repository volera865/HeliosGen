import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { uploadBuffer } from "@/lib/r2";

const execFileAsync = promisify(execFile);

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ffmpegBin(): Promise<string> {
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]) {
    try {
      await execFileAsync(candidate, ["-version"], { timeout: 8000 });
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("ffmpeg is not installed. Install it to attach narration to talking videos.");
}

/** Replace the video soundtrack with the TTS / uploaded narration. */
export async function muxNarrationOntoVideo(videoUrl: string, audioUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "talk-mux-"));
  const vPath = join(dir, "in.mp4");
  const aPath = join(dir, "vo.audio");
  const oPath = join(dir, "out.mp4");
  try {
    const [video, audio] = await Promise.all([download(videoUrl), download(audioUrl)]);
    await writeFile(vPath, video);
    await writeFile(aPath, audio);
    const bin = await ffmpegBin();
    await execFileAsync(bin, [
      "-y",
      "-i", vPath,
      "-i", aPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      oPath,
    ], { timeout: 120_000 });
    const out = await readFile(oPath);
    return uploadBuffer(out, "video/mp4", "videos");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
