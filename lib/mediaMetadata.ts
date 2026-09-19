import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

/** Strip EXIF/IPTC/XMP (images) or metadata tags (video) from a buffer before storage. */
export async function stripMetadata(buffer: Buffer, contentType: string): Promise<Buffer> {
  if (contentType.startsWith("image/")) {
    return sharp(buffer).toBuffer();
  }
  if (contentType.startsWith("video/")) {
    const extension = contentType.includes("webm") ? "webm" : "mp4";
    let inputPath:  string | null = null;
    let outputPath: string | null = null;
    try {
      const tmpDir = await mkdtemp(join(tmpdir(), "strip-meta-"));
      inputPath  = join(tmpDir, `input.${extension}`);
      outputPath = join(tmpDir, `output.${extension}`);
      await writeFile(inputPath, buffer);
      await execFileAsync("ffmpeg", [
        "-i", inputPath,
        "-map_metadata", "-1",
        "-c", "copy",
        "-y", outputPath,
      ]);
      return await readFile(outputPath);
    } catch (err) {
      // No ffmpeg binary (or no writable tmp dir) on the host: storing the
      // original bytes is better than failing the whole upload.
      console.warn(`[mediaMetadata] video metadata strip skipped: ${err instanceof Error ? err.message : String(err)}`);
      return buffer;
    } finally {
      await Promise.all([
        inputPath  ? unlink(inputPath).catch(()  => {}) : Promise.resolve(),
        outputPath ? unlink(outputPath).catch(() => {}) : Promise.resolve(),
      ]);
    }
  }
  return buffer;
}
