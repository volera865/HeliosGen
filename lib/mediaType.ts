/** Map a MIME type to a file extension. Audio must not fall through to jpg. */
export function extFromContentType(contentType: string): string {
  const t = (contentType ?? "").toLowerCase().split(";")[0].trim();
  if (t.startsWith("audio/")) {
    if (t.includes("wav")) return "wav";
    if (t.includes("aac")) return "aac";
    if (t.includes("ogg")) return "ogg";
    if (t.includes("m4a") || t === "audio/mp4") return "m4a";
    return "mp3";
  }
  if (t.includes("webm")) return "webm";
  if (t.includes("quicktime")) return "mov";
  if (t.includes("mp4")) return "mp4";
  if (t.includes("png")) return "png";
  if (t.includes("gif")) return "gif";
  if (t.includes("webp")) return "webp";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  return "bin";
}

export function mimeFromFileName(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".mp4")) return "video/mp4";
  if (n.endsWith(".webm")) return "video/webm";
  if (n.endsWith(".mov")) return "video/quicktime";
  if (n.endsWith(".mp3")) return "audio/mpeg";
  if (n.endsWith(".wav")) return "audio/wav";
  if (n.endsWith(".aac")) return "audio/aac";
  if (n.endsWith(".m4a")) return "audio/mp4";
  if (n.endsWith(".ogg")) return "audio/ogg";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

export function urlMatchesContentType(url: string, contentType: string): boolean {
  const want = extFromContentType(contentType);
  const path = url.split("?")[0].toLowerCase();
  return path.endsWith(`.${want}`);
}

/** Prefer magic bytes over a wrong extension (guest uploads used to save mp3 as .jpg). */
export function sniffMedia(buffer: Buffer, fileName: string): { mime: string; ext: string } {
  if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return { mime: "audio/mpeg", ext: "mp3" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return { mime: "audio/mpeg", ext: "mp3" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  ) {
    return { mime: "audio/wav", ext: "wav" };
  }
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") {
    return { mime: "audio/ogg", ext: "ogg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    if (brand.startsWith("m4a") || brand.startsWith("mp4a")) {
      return { mime: "audio/mp4", ext: "m4a" };
    }
    return { mime: "video/mp4", ext: "mp4" };
  }
  if (buffer.length >= 8 && buffer.toString("ascii", 0, 8) === "ftypM4A") {
    return { mime: "audio/mp4", ext: "m4a" };
  }
  const mime = mimeFromFileName(fileName);
  return { mime, ext: extFromContentType(mime) };
}
