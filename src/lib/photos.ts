import type { PhotoRecord } from "./types";
import { uid } from "./template";

/* Photos are compressed on the phone before they are stored: max 1600px long edge at JPEG 0.72
   (typically 150-350 KB) plus a 320px thumbnail for the screens, the move-in file and the PDF grid. */
const FULL = 1600, THUMB = 320;

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
  }
}

function draw(src: ImageBitmap | HTMLImageElement, edge: number, q: number): Promise<{ blob: Blob; w: number; h: number }> {
  const sw = "naturalWidth" in src ? src.naturalWidth : src.width;
  const sh = "naturalHeight" in src ? src.naturalHeight : src.height;
  const s = Math.min(1, edge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res({ blob: b, w, h }) : rej(new Error("encode"))), "image/jpeg", q));
}

export async function processPhoto(file: File, reportId: string): Promise<PhotoRecord> {
  const src = await decode(file);
  const full = await draw(src, FULL, 0.72);
  const thumb = await draw(src, THUMB, 0.7);
  if ("close" in src) src.close();
  return { id: uid("p"), reportId, blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h, takenAt: new Date().toISOString() };
}
