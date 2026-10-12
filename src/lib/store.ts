/* In-progress autosave only. Nothing here is a saved report: a finished inspection leaves the
   app only through the Email report step (src/lib/email-report.ts), then the draft is cleared.
   - The inspection in progress (text, choices, signatures) lives in localStorage: small,
     synchronous, survives a refresh. Saved on every change.
   - Its photos are Blobs in IndexedDB (localStorage tops out around 5 MB).
   v3 removed the "saved reports" store and the move-in .json file; DB v2 drops the old store. */
import type { PhotoRecord, Report } from "./types";

const DRAFT_KEY = "sfpm-inspection-draft-v1";
const DB_NAME = "sfpm-inspections";
const DB_VER = 2;

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
      if (d.objectStoreNames.contains("reports")) d.deleteObjectStore("reports"); // v1/v2 saved-reports list, retired in v3
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

/** Drop photos that belong to no inspection in progress (left over from retired saved reports). */
export async function prunePhotos(keepReportId: string | null) {
  const all = await tx<PhotoRecord[]>("photos", "readonly", (s) => s.getAll());
  await Promise.all(all.filter((p) => p.reportId !== keepReportId).map((p) => deletePhoto(p.id)));
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

export const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
