/* Device storage.
   - The report in progress (text, choices, signatures) lives in localStorage: small, synchronous,
     survives a refresh. Saved on every change.
   - Photos are Blobs in IndexedDB (localStorage tops out around 5 MB).
   - Completed reports are kept in IndexedDB too ("Saved on this device"), so a move-out can load
     the move-in taken on the same phone. */
import type { PhotoRecord, Report, ReportFile } from "./types";

const DRAFT_KEY = "sfpm-inspection-draft-v1";
const DB_NAME = "sfpm-inspections";
const DB_VER = 1;

export function loadDraft(): Report | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Report;
    return r && r.v === 1 && r.id ? r : null;
  } catch { return null; }
}
export function saveDraft(r: Report | null): boolean {
  try {
    if (!r) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(r));
    return true;
  } catch { return false; }
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos", { keyPath: "id" }).createIndex("reportId", "reportId");
      if (!d.objectStoreNames.contains("reports")) d.createObjectStore("reports", { keyPath: "id" });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => { dbp = null; rej(req.error); };
  });
  return dbp;
}
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => res(r ? (r as IDBRequest<T>).result : (undefined as T));
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

export const putPhoto = (p: PhotoRecord) => tx<IDBValidKey>("photos", "readwrite", (s) => s.put(p));
export const getPhoto = (id: string) => tx<PhotoRecord | undefined>("photos", "readonly", (s) => s.get(id));
export const deletePhoto = (id: string) => tx<undefined>("photos", "readwrite", (s) => s.delete(id));

export async function photosFor(reportId: string): Promise<PhotoRecord[]> {
  return tx<PhotoRecord[]>("photos", "readonly", (s) => s.index("reportId").getAll(reportId));
}
export async function deletePhotosFor(reportId: string) {
  const all = await photosFor(reportId);
  await Promise.all(all.map((p) => deletePhoto(p.id)));
}

export const putReport = (r: Report) => tx<IDBValidKey>("reports", "readwrite", (s) => s.put(r));
export const getReport = (id: string) => tx<Report | undefined>("reports", "readonly", (s) => s.get(id));
export const deleteReport = (id: string) => tx<undefined>("reports", "readwrite", (s) => s.delete(id));
export async function listReports(): Promise<Report[]> {
  const all = await tx<Report[]>("reports", "readonly", (s) => s.getAll());
  return all.sort((a, b) => (b.completedAt || b.createdAt).localeCompare(a.completedAt || a.createdAt));
}

export async function requestPersistence() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* ignore */ }
}

/* ---------- object URLs for photos, cached per session ---------- */
const urlCache = new Map<string, string>();
export async function photoUrl(id: string, thumb = true): Promise<string | null> {
  const k = `${id}:${thumb ? "t" : "f"}`;
  if (urlCache.has(k)) return urlCache.get(k)!;
  const p = await getPhoto(id).catch(() => undefined);
  if (!p) return null;
  const u = URL.createObjectURL(thumb ? p.thumb : p.blob);
  urlCache.set(k, u);
  return u;
}

/* ---------- portable file ---------- */
export const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
export async function dataUrlToBlob(u: string): Promise<Blob> { return (await fetch(u)).blob(); }

async function shrink(b: Blob, edge = 960): Promise<Blob> {
  try {
    const bm = await createImageBitmap(b);
    const s = Math.min(1, edge / Math.max(bm.width, bm.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bm.width * s); c.height = Math.round(bm.height * s);
    c.getContext("2d")!.drawImage(bm, 0, 0, c.width, c.height);
    bm.close();
    return await new Promise<Blob>((res) => c.toBlob((x) => res(x ?? b), "image/jpeg", 0.7));
  } catch { return b; }
}

export async function buildReportFile(r: Report): Promise<ReportFile> {
  const thumbs: Record<string, string> = {}, taken: Record<string, string> = {};
  for (const p of await photosFor(r.id)) { thumbs[p.id] = await blobToDataUrl(await shrink(p.blob)); taken[p.id] = p.takenAt; }
  return { kind: "sfpm-inspection", v: 1, report: r, thumbs, taken };
}

/** Import a move-in file: the report goes to the saved list, its thumbnails into IndexedDB. */
export async function importReportFile(text: string): Promise<Report> {
  let f: ReportFile;
  try { f = JSON.parse(text); } catch { throw new Error("This file could not be read. Choose the .json file saved at the end of a move-in."); }
  if (f?.kind !== "sfpm-inspection" || !f.report?.id) throw new Error("This is not a saved inspection file.");
  if (f.report.type !== "in") throw new Error("This file is a move-out report. Choose the move-in file.");
  for (const [id, url] of Object.entries(f.thumbs ?? {})) {
    if (await getPhoto(id).catch(() => undefined)) continue;
    const b = await dataUrlToBlob(url);
    let w = 4, h = 3;
    try { const bm = await createImageBitmap(b); w = bm.width; h = bm.height; bm.close(); } catch { /* keep 4:3 */ }
    await putPhoto({ id, reportId: f.report.id, blob: b, thumb: b, w, h, takenAt: f.taken?.[id] ?? "" });
  }
  await putReport({ ...f.report, status: "complete" });
  return f.report;
}
