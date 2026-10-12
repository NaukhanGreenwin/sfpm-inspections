"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Condition, InspectionType, Item, Report, Room, TenantSignature } from "@/lib/types";
import {
  CONDITIONS, COMPANY, ISSUES, MAIN_SITE, OFFICE_PHONE_DISPLAY, OFFICE_PHONE_TEL, PRIVACY_URL, ROOM_DEFS,
  addressLine, condLabel, fmtDate, fmtDateTime, insertRoom, itemChange, makeItem, newReport, renumber, typeLabel, unmarked,
} from "@/lib/template";
import {
  buildReportFile, deletePhoto, deletePhotosFor, deleteReport, importReportFile, listReports, loadDraft, photoUrl, putPhoto,
  putReport, requestPersistence, saveDraft,
} from "@/lib/store";
import { processPhoto } from "@/lib/photos";
import { applyBaseline, detachBaseline } from "@/lib/compare";
import { submitInspectionReport } from "@/lib/submit-report";
import PhotoStrip, { Thumb } from "./PhotoStrip";
import SignaturePad from "./SignaturePad";
import { IconArrowLeft, IconArrowRight, IconCheck, IconClose, IconPhone, IconShield } from "./icons";

/* ------------------------------------------------------------------ */
/* steps                                                               */
/* ------------------------------------------------------------------ */
interface Step { key: string; label: string }
function stepsFor(r: Report): Step[] {
  return [
    ...(r.type === "out" ? [{ key: "baseline", label: "Move-in report" }] : []),
    { key: "details", label: "Inspection details" },
    { key: "layout", label: "Rooms in this unit" },
    ...r.rooms.map((x) => ({ key: `room:${x.id}`, label: x.name })),
    ...(r.type === "out" ? [{ key: "notes", label: "Move-out notes" }] : []),
    { key: "review", label: "Review" },
    { key: "sign", label: "Signatures" },
  ];
}
const splitTenants = (s: string) => s.split(/\s*(?:,|&|\band\b|\n|;)\s*/i).map((x) => x.trim()).filter(Boolean).slice(0, 6);

function validateDetails(r: Report): Record<string, string> {
  const d = r.details, e: Record<string, string> = {};
  if (!d.address.trim()) e.address = "Enter the property address.";
  if (!d.tenants.trim()) e.tenants = "Enter the tenant name(s).";
  if (!d.inspector.trim()) e.inspector = "Enter who is doing the inspection.";
  if (!d.date) e.date = "Choose the inspection date.";
  return e;
}
function validateSign(r: Report): Record<string, string> {
  const e: Record<string, string> = {};
  if (r.details.tenantPresent) {
    r.tenantSigs.forEach((s, i) => {
      if (!s.name.trim()) e[`tn${i}`] = "Enter the tenant's name.";
      if (!s.agree) e[`ta${i}`] = "Choose one.";
      if (s.agree !== "declined" && !s.dataUrl) e[`ts${i}`] = "Tenant signature needed, or choose Declined to sign.";
    });
  }
  if (!r.landlordSig?.name.trim()) e.ln = "Enter the landlord or agent's name.";
  if (!r.landlordSig?.dataUrl) e.ls = "Landlord or agent signature needed.";
  return e;
}

type Dialog = { title: string; body: ReactNode; actions: { label: string; kind?: "primary" | "quiet" | "alert"; run: () => void }[] } | null;

/* ------------------------------------------------------------------ */
export default function App() {
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [home, setHome] = useState(true);
  const [saved, setSaved] = useState<Report[] | null>(null); // "Saved on this device" screen when not null
  const [viewing, setViewing] = useState<Report | null>(null); // a saved report opened read-only
  const [dialog, setDialog] = useState<Dialog>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"saved" | "error" | "">("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  /* ---------- boot: restore draft, service worker ---------- */
  useEffect(() => {
    const d = loadDraft();
    if (d) { setReport(d); setHome(false); }
    setReady(true);
    void requestPersistence();
    if ("serviceWorker" in navigator && location.hostname !== "localhost") navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  /* ---------- autosave (every change, debounced) ---------- */
  const pending = useRef<Report | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (pending.current) { setSaveState(saveDraft(pending.current) ? "saved" : "error"); pending.current = null; }
  }, []);
  useEffect(() => {
    if (!ready || !report) return;
    pending.current = report;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 250);
  }, [report, ready, flush]);
  useEffect(() => {
    const h = () => flush();
    window.addEventListener("pagehide", h);
    document.addEventListener("visibilitychange", h);
    return () => { window.removeEventListener("pagehide", h); document.removeEventListener("visibilitychange", h); };
  }, [flush]);

  // once errors are on screen, re-check on every edit so fixed fields clear straight away
  useEffect(() => {
    if (!report || !Object.keys(errors).length) return;
    const e = report.screen === "details" ? validateDetails(report) : report.screen === "sign" ? validateSign(report) : null;
    if (e && JSON.stringify(e) !== JSON.stringify(errors)) setErrors(e);
  }, [report, errors]);

  const update = useCallback((fn: (r: Report) => Report) => setReport((r) => (r ? fn(r) : r)), []);
  const screen = report?.screen ?? "";
  const steps = useMemo(() => (report ? stepsFor(report) : []), [report]);
  const stepIdx = Math.max(0, steps.findIndex((s) => s.key === screen));

  const scrollTop = () => { pageRef.current?.scrollTo({ top: 0 }); window.scrollTo({ top: 0 }); };
  const go = (key: string) => {
    setErrors({}); setSheet(false);
    update((r) => ({ ...r, screen: key }));
    scrollTop();
    setTimeout(() => headingRef.current?.focus({ preventScroll: true }), 30);
  };

  /* ---------- start / resume / exit ---------- */
  const begin = (type: InspectionType) => {
    const start = () => {
      if (report && report.status === "draft") void deletePhotosFor(report.id);
      const r = newReport(type);
      if (type === "out") r.screen = "baseline";
      setReport(r); saveDraft(r); setHome(false); setSaved(null); setViewing(null); setDialog(null); scrollTop();
    };
    if (report && report.status === "draft") {
      setDialog({
        title: `You have an unfinished ${typeLabel(report.type).toLowerCase()} inspection`,
        body: <p>{addressLine(report.details) || "No address entered yet"}. Started {fmtDateTime(report.createdAt)}.</p>,
        actions: [
          { label: "Resume it", kind: "primary", run: () => { setDialog(null); setHome(false); } },
          { label: `Discard it and start a ${typeLabel(type).toLowerCase()}`, kind: "alert", run: start },
        ],
      });
    } else start();
  };
  const exitToHome = () => { flush(); setHome(true); setSaved(null); setViewing(null); setSheet(false); scrollTop(); };
  const closeCompleted = () => { saveDraft(null); setReport(null); exitToHome(); };
  const openSaved = async () => { setSaved(await listReports().catch(() => [])); setHome(true); setViewing(null); scrollTop(); };

  /* ---------- photo plumbing ---------- */
  const addPhotos = useCallback(async (files: File[], attach: (ids: string[]) => void) => {
    if (!report) return;
    const ids: string[] = [];
    for (const f of files) {
      try { const p = await processPhoto(f, report.id); await putPhoto(p); ids.push(p.id); }
      catch { setDialog({ title: "That photo could not be added", body: <p>{f.name} could not be read on this device. Try taking the photo again with the camera.</p>, actions: [{ label: "OK", kind: "primary", run: () => setDialog(null) }] }); }
    }
    if (ids.length) attach(ids);
  }, [report]);
  const removePhoto = (id: string, detach: () => void) => { detach(); void deletePhoto(id); };

  /* ---------- room/item updates ---------- */
  const patchRoom = (roomId: string, fn: (room: Room) => Room) => update((r) => ({ ...r, rooms: r.rooms.map((x) => (x.id === roomId ? fn(x) : x)) }));
  const patchItem = (roomId: string, itemId: string, patch: Partial<Item>) =>
    patchRoom(roomId, (room) => ({ ...room, items: room.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }));

  /* ---------- navigation with validation ---------- */
  const next = () => {
    if (!report) return;
    const r = report;
    if (screen === "details") {
      const e = validateDetails(r);
      setErrors(e);
      if (Object.keys(e).length) { setTimeout(() => document.querySelector<HTMLElement>(".has-error input, .has-error textarea")?.focus(), 20); return; }
    }
    if (screen.startsWith("room:")) {
      const room = r.rooms.find((x) => `room:${x.id}` === screen);
      const n = room ? unmarked(room) : 0;
      if (room && n > 0) {
        setDialog({
          title: `${n} item${n > 1 ? "s" : ""} not marked`,
          body: <p>{room.items.filter((i) => !i.cond).map((i) => i.label).join(", ")}.</p>,
          actions: [
            { label: `Mark ${n > 1 ? "them" : "it"} Good and continue`, kind: "primary", run: () => { setDialog(null); markAllGood(room.id); go(steps[stepIdx + 1].key); } },
            { label: "Leave blank and continue", kind: "quiet", run: () => { setDialog(null); go(steps[stepIdx + 1].key); } },
            { label: "Stay on this room", kind: "quiet", run: () => setDialog(null) },
          ],
        });
        return;
      }
    }
    if (screen === "sign") return complete();
    if (stepIdx < steps.length - 1) go(steps[stepIdx + 1].key);
  };
  const back = () => { if (stepIdx > 0) go(steps[stepIdx - 1].key); else exitToHome(); };
  const markAllGood = (roomId: string) => patchRoom(roomId, (room) => ({ ...room, items: room.items.map((i) => (i.cond ? i : { ...i, cond: "good" as Condition })) }));

  /* ---------- complete ---------- */
  const complete = () => {
    if (!report) return;
    const r = report, e = validateSign(r);
    setErrors(e);
    if (Object.keys(e).length) { setTimeout(() => document.querySelector<HTMLElement>(".has-error")?.scrollIntoView({ block: "center" }), 20); return; }
    const done: Report = { ...r, status: "complete", completedAt: new Date().toISOString(), screen: "done" };
    setReport(done); saveDraft(done);
    void putReport(done);
    scrollTop();
  };

  if (!ready) return <div className="page" ref={pageRef}><Masthead onHome={() => {}} /></div>;

  /* ---------- which view ---------- */
  const doneView = viewing ?? (report && report.status === "complete" && !home ? report : null);
  const inFlow = !!report && !home && report.status === "draft";
  const curStep = steps[stepIdx];

  return (
    <div className="page" ref={pageRef}>
      <a className="skip" href="#main">Skip to the checklist</a>
      <Masthead onHome={exitToHome} />

      <div className="layout">
        <aside className="rail" aria-label="Inspection outline">
          <div className="rail-inner">
            {inFlow && report ? (
              <>
                <p className="eyebrow">{typeLabel(report.type)} inspection</p>
                <h1 className="rail-title rail-title-sm">{addressLine(report.details) || "New inspection"}</h1>
                <ol className="rail-steps rail-steps-scroll">
                  {steps.map((s, i) => {
                    const room = s.key.startsWith("room:") ? report.rooms.find((x) => `room:${x.id}` === s.key) : null;
                    const state = i === stepIdx ? "current" : i < stepIdx ? "done" : "todo";
                    return (
                      <li key={s.key} className={`rail-step is-${state}`} aria-current={i === stepIdx ? "step" : undefined}>
                        <button type="button" className="rail-jump" onClick={() => go(s.key)}>
                          <span className="rail-num tnum">{state === "done" ? <IconCheck size={14} /> : String(i + 1).padStart(2, "0")}</span>
                          <span className="rail-label">{s.label}</span>
                          {room && room.kind === "std" && <span className="rail-meta tnum">{room.items.length - unmarked(room)}/{room.items.length}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <>
                <p className="eyebrow">Property management</p>
                <h1 className="rail-title">Unit condition inspection</h1>
                <p className="rail-lede">Walk the unit room by room, mark each item, add photos, and both sides sign on the phone. The report is a PDF you can download, share or print.</p>
                <ol className="rail-steps">
                  {["Details and rooms", "Room-by-room checklist", "Review", "Signatures", "PDF report"].map((s, i) => (
                    <li key={s} className="rail-step"><span className="rail-num tnum">{String(i + 1).padStart(2, "0")}</span><span className="rail-label">{s}</span></li>
                  ))}
                </ol>
              </>
            )}
            <div className="rail-foot"><TrustLine /></div>
          </div>
        </aside>

        <main id="main" className="main" tabIndex={-1}>
          {doneView ? (
            <Done r={doneView} headingRef={headingRef} isSaved={!!viewing}
              onClose={viewing ? () => { setViewing(null); void openSaved(); } : closeCompleted}
              onDelete={viewing ? () => setDialog({
                title: "Delete this report from this device?",
                body: <p>The PDF or file you already shared is not affected. This cannot be undone.</p>,
                actions: [
                  { label: "Delete", kind: "alert", run: async () => { await deleteReport(viewing.id); await deletePhotosFor(viewing.id); setDialog(null); setViewing(null); void openSaved(); } },
                  { label: "Keep it", kind: "quiet", run: () => setDialog(null) },
                ],
              }) : undefined}
            />
          ) : saved ? (
            <SavedList list={saved} onOpen={(r) => { setViewing(r); setSaved(null); scrollTop(); }} onBack={() => setSaved(null)}
              onImport={async (text) => { try { await importReportFile(text); setSaved(await listReports()); } catch (err) { setDialog({ title: "File not loaded", body: <p>{(err as Error).message}</p>, actions: [{ label: "OK", kind: "primary", run: () => setDialog(null) }] }); } }} />
          ) : !inFlow || !report ? (
            <Landing draft={report && report.status === "draft" ? report : null} onStart={begin} onResume={() => setHome(false)} onSaved={openSaved} />
          ) : (
            <form className="flow" noValidate onSubmit={(e) => { e.preventDefault(); next(); }}>
              <div className="progress">
                <div className="progress-meta">
                  <span className="tnum">Step {stepIdx + 1} of {steps.length}</span>
                  <button type="button" className="link progress-jump" onClick={() => setSheet(true)}>All steps</button>
                </div>
                <div className="progress-bar"><span style={{ width: `${((stepIdx + 1) / steps.length) * 100}%` }} /></div>
              </div>

              <section key={screen} className="step" aria-labelledby="step-title">
                <p className="step-num tnum" aria-hidden="true">{typeLabel(report.type)} · {String(stepIdx + 1).padStart(2, "0")}</p>
                <h2 id="step-title" ref={headingRef} tabIndex={-1} className="step-title">{titleFor(report, curStep)}</h2>
                <div className="step-body">
                  {screen === "baseline" && <BaselineStep r={report} update={update} setDialog={setDialog} />}
                  {screen === "details" && <DetailsStep r={report} update={update} errors={errors} />}
                  {screen === "layout" && <LayoutStep r={report} update={update} setDialog={setDialog} />}
                  {screen.startsWith("room:") && (() => {
                    const room = report.rooms.find((x) => `room:${x.id}` === screen);
                    if (!room) return <p className="lede-sm">This room was removed. <button type="button" className="link" onClick={() => go("layout")}>Back to rooms</button></p>;
                    return <RoomStep r={report} room={room} patchRoom={patchRoom} patchItem={patchItem} markAllGood={markAllGood}
                      addPhotos={addPhotos} removePhoto={removePhoto} onOpen={setLightbox} />;
                  })()}
                  {screen === "notes" && <NotesStep r={report} update={update} />}
                  {screen === "review" && <ReviewStep r={report} go={go} />}
                  {screen === "sign" && <SignStep r={report} update={update} errors={errors} />}
                </div>
              </section>

              <div className="actions">
                <div className="actions-inner">
                  <button type="button" className="btn btn-ghost" onClick={back}><IconArrowLeft size={20} /><span>Back</span></button>
                  <button type="submit" className="btn btn-primary btn-next">
                    <span>{screen === "sign" ? "Complete inspection" : screen === "review" ? "Continue to signatures" : "Continue"}</span>
                    {screen !== "sign" && <IconArrowRight size={20} />}
                  </button>
                </div>
                <p className="autosave" aria-live="polite">{saveState === "error" ? "Not saved: this device's storage is full" : "Saved on this device"}</p>
              </div>
            </form>
          )}
        </main>
      </div>

      <footer className="footer">
        <div className="footer-inner">
          <p>{COMPANY}</p>
          <p><a href={PRIVACY_URL} target="_blank" rel="noopener">Privacy</a><span aria-hidden="true"> · </span><a href={MAIN_SITE}>stressfreepm.ca</a></p>
        </div>
      </footer>

      {sheet && report && (
        <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label="All steps" onClick={() => setSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><h2>All steps</h2><button type="button" className="icon-btn" onClick={() => setSheet(false)} aria-label="Close"><IconClose size={20} /></button></div>
            <ol className="sheet-list">
              {steps.map((s, i) => {
                const room = s.key.startsWith("room:") ? report.rooms.find((x) => `room:${x.id}` === s.key) : null;
                const left = room ? unmarked(room) : 0;
                return (
                  <li key={s.key}>
                    <button type="button" className={`sheet-row${i === stepIdx ? " is-current" : ""}`} onClick={() => go(s.key)}>
                      <span className="rail-num tnum">{String(i + 1).padStart(2, "0")}</span>
                      <span className="sheet-label">{s.label}</span>
                      {room && room.kind === "std" && <span className={`sheet-meta tnum${left ? "" : " is-done"}`}>{left ? `${left} left` : <IconCheck size={16} />}</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}

      {lightbox && <Lightbox id={lightbox} onClose={() => setLightbox(null)} />}
      {dialog && (
        <div className="sheet-wrap is-center" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
          <div className="dialog">
            <h2 id="dlg-title" className="dialog-title">{dialog.title}</h2>
            <div className="dialog-body">{dialog.body}</div>
            <div className="dialog-actions">
              {dialog.actions.map((a) => <button key={a.label} type="button" className={`btn btn-block btn-${a.kind ?? "quiet"}`} onClick={a.run}>{a.label}</button>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function titleFor(r: Report, s: Step | undefined): string {
  if (!s) return "";
  if (s.key === "baseline") return "Start from the move-in report";
  if (s.key === "details") return "Inspection details";
  if (s.key === "layout") return "Rooms in this unit";
  if (s.key === "notes") return "Move-out notes";
  if (s.key === "review") return "Review the report";
  if (s.key === "sign") return "Signatures";
  return s.label;
}

/* ------------------------------------------------------------------ */
/* shell pieces                                                        */
/* ------------------------------------------------------------------ */
function Masthead({ onHome }: { onHome: () => void }) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <button type="button" className="brand brand-btn" onClick={onHome} aria-label="Inspections home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo.svg" alt="Stress Free Property Management" width={1280} height={240} />
        </button>
        <a className="masthead-call" href={`tel:${OFFICE_PHONE_TEL}`} aria-label={`Call the office, ${OFFICE_PHONE_DISPLAY}`}>
          <IconPhone size={18} /><span className="masthead-call-text">{OFFICE_PHONE_DISPLAY}</span>
        </a>
      </div>
    </header>
  );
}
function TrustLine() {
  return (
    <div>
      <p className="trust-row"><IconShield size={18} /> Stays on this device</p>
      <p className="trust-note">Nothing is uploaded. Photos and signatures are kept on this phone until you download or share the report.</p>
    </div>
  );
}
function Lightbox({ id, onClose }: { id: string; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { photoUrl(id, false).then(setSrc); }, [id]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Photo" onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && <img src={src} alt="Inspection photo, full size" />}
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close photo"><IconClose size={22} /></button>
    </div>
  );
}

function Field({ id, label, optional, hint, error, children }: { id: string; label: string; optional?: boolean; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label className="field-label" htmlFor={id}>{label}{optional && <span className="field-optional"> (optional)</span>}</label>
      {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}
      {children}
      {error && <p className="field-error" id={`${id}-error`}>{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* landing                                                             */
/* ------------------------------------------------------------------ */
function Landing({ draft, onStart, onResume, onSaved }: { draft: Report | null; onStart: (t: InspectionType) => void; onResume: () => void; onSaved: () => void }) {
  const progress = draft ? (() => { const s = stepsFor(draft); const i = s.findIndex((x) => x.key === draft.screen); return `Step ${Math.max(1, i + 1)} of ${s.length}`; })() : "";
  return (
    <div className="flow landing step">
      <div className="landing-intro">
        <p className="eyebrow">Unit inspections</p>
        <h1 className="mobile-title">Condition inspection</h1>
        <p className="mobile-lede">Choose the inspection. Each one walks the unit room by room and ends with signatures and a PDF report.</p>
      </div>

      {draft && (
        <div className="resume">
          <p className="eyebrow eyebrow-accent">In progress</p>
          <p className="resume-title">{typeLabel(draft.type)} · {addressLine(draft.details) || "No address yet"}</p>
          <p className="resume-meta tnum">{progress} · started {fmtDateTime(draft.createdAt)}</p>
          <button type="button" className="btn btn-primary btn-block" onClick={onResume}><span>Resume</span><IconArrowRight size={20} /></button>
        </div>
      )}

      <div className="big-choices">
        <button type="button" className="big-choice" onClick={() => onStart("in")}>
          <span className="big-kicker">Start of tenancy</span>
          <span className="big-label">Move In</span>
          <span className="big-sub">Record the condition of every room before the tenant moves in.</span>
          <span className="big-arrow" aria-hidden="true"><IconArrowRight size={26} /></span>
        </button>
        <button type="button" className="big-choice big-choice-alt" onClick={() => onStart("out")}>
          <span className="big-kicker">End of tenancy</span>
          <span className="big-label">Move Out</span>
          <span className="big-sub">Load the move-in report and note what has changed.</span>
          <span className="big-arrow" aria-hidden="true"><IconArrowRight size={26} /></span>
        </button>
      </div>

      <button type="button" className="saved-link" onClick={onSaved}>
        <span>Saved on this device</span><span className="saved-sub">Open, download or delete completed reports</span><IconArrowRight size={18} />
      </button>
      <div className="mobile-trust"><TrustLine /></div>
    </div>
  );
}

function SavedList({ list, onOpen, onBack, onImport }: { list: Report[]; onOpen: (r: Report) => void; onBack: () => void; onImport: (text: string) => void }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="flow step">
      <p className="eyebrow">This device</p>
      <h2 className="step-title">Saved reports</h2>
      <div className="step-body stack-lg">
        {list.length ? (
          <ul className="report-list">
            {list.map((r) => (
              <li key={r.id}>
                <button type="button" className="report-row" onClick={() => onOpen(r)}>
                  <span className="report-type">{typeLabel(r.type)}</span>
                  <span className="report-addr">{addressLine(r.details)}</span>
                  <span className="report-meta tnum">{fmtDate(r.details.date)} · {r.details.tenants} · {r.id}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="review-empty">No completed reports on this device yet.</p>}
        <div className="stack-md">
          <button type="button" className="btn btn-quiet btn-block" onClick={() => file.current?.click()}>Open a saved move-in file (.json)</button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) onImport(await f.text()); e.target.value = ""; }} />
          <button type="button" className="btn btn-ghost" onClick={onBack}><IconArrowLeft size={20} /><span>Back</span></button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* steps                                                               */
/* ------------------------------------------------------------------ */
type Upd = (fn: (r: Report) => Report) => void;

function BaselineStep({ r, update, setDialog }: { r: Report; update: Upd; setDialog: (d: Dialog) => void }) {
  const [list, setList] = useState<Report[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { listReports().then((all) => setList(all.filter((x) => x.type === "in"))).catch(() => setList([])); }, []);
  const use = (mi: Report) => {
    const hasWork = r.rooms.some((x) => x.items.some((i) => i.cond));
    const apply = () => { update((cur) => ({ ...applyBaseline(cur, mi), screen: "details" })); setDialog(null); };
    if (hasWork && r.baselineRef?.id !== mi.id) setDialog({
      title: "Replace the rooms with the move-in layout?",
      body: <p>Marks already made on this move-out will be cleared.</p>,
      actions: [{ label: "Load the move-in", kind: "primary", run: apply }, { label: "Cancel", kind: "quiet", run: () => setDialog(null) }],
    });
    else apply();
  };
  const fromFile = async (f: File) => {
    try { const mi = await importReportFile(await f.text()); setList((l) => [mi, ...(l ?? []).filter((x) => x.id !== mi.id)]); use(mi); }
    catch (err) { setDialog({ title: "File not loaded", body: <p>{(err as Error).message}</p>, actions: [{ label: "OK", kind: "primary", run: () => setDialog(null) }] }); }
  };
  return (
    <div className="stack-lg">
      <p className="lede-sm">Loading the move-in report fills in the address, tenants and rooms, and shows the move-in condition next to every item so changes stand out.</p>
      {r.baselineRef && (
        <div className="note note-ok"><IconCheck size={18} /><span>Loaded move-in report <strong>{r.baselineRef.id}</strong> from {fmtDate(r.baselineRef.date)}. <button type="button" className="link" onClick={() => update((cur) => detachBaseline(cur))}>Remove</button></span></div>
      )}
      <fieldset className="group">
        <legend className="group-label">Saved on this device</legend>
        {list === null ? <p className="review-empty">Looking…</p> : list.length ? (
          <ul className="report-list">
            {list.map((mi) => (
              <li key={mi.id}>
                <button type="button" className={`report-row${r.baselineRef?.id === mi.id ? " is-selected" : ""}`} onClick={() => use(mi)}>
                  <span className="report-type">Move-in · {fmtDate(mi.details.date)}</span>
                  <span className="report-addr">{addressLine(mi.details)}</span>
                  <span className="report-meta tnum">{mi.details.tenants} · {mi.id}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="review-empty">No move-in reports on this device.</p>}
      </fieldset>
      <fieldset className="group">
        <legend className="group-label">From a file</legend>
        <button type="button" className="btn btn-quiet btn-block" onClick={() => file.current?.click()}>Open the move-in file (.json)</button>
        <p className="field-hint hint-after">The file saved at the end of the move-in, from email, Drive, Files or AirDrop.</p>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromFile(f); e.target.value = ""; }} />
      </fieldset>
      {!r.baselineRef && <p className="lede-sm">No move-in report? Tap Continue to do the move-out on its own.</p>}
    </div>
  );
}

function DetailsStep({ r, update, errors }: { r: Report; update: Upd; errors: Record<string, string> }) {
  const d = r.details;
  const set = (k: keyof Report["details"], v: string | boolean) => update((cur) => ({ ...cur, details: { ...cur.details, [k]: v } }));
  return (
    <div className="stack-md">
      <div className="grid-address">
        <Field id="address" label="Property address" error={errors.address}>
          <input id="address" type="text" autoComplete="street-address" value={d.address} onChange={(e) => set("address", e.target.value)} aria-invalid={!!errors.address} />
        </Field>
        <Field id="unit" label="Unit" optional>
          <input id="unit" type="text" value={d.unit} onChange={(e) => set("unit", e.target.value)} />
        </Field>
      </div>
      <Field id="city" label="City" optional>
        <input id="city" type="text" autoComplete="address-level2" value={d.city} onChange={(e) => set("city", e.target.value)} />
      </Field>
      <Field id="tenants" label="Tenant name(s)" hint="Separate names with commas." error={errors.tenants}>
        <input id="tenants" type="text" autoComplete="off" value={d.tenants} onChange={(e) => set("tenants", e.target.value)} aria-invalid={!!errors.tenants} />
      </Field>
      <div className="grid-2">
        <Field id="inspector" label="Inspected by" error={errors.inspector}>
          <input id="inspector" type="text" autoComplete="name" value={d.inspector} onChange={(e) => set("inspector", e.target.value)} aria-invalid={!!errors.inspector} />
        </Field>
        <Field id="date" label="Inspection date" error={errors.date}>
          <input id="date" type="date" value={d.date} onChange={(e) => set("date", e.target.value)} aria-invalid={!!errors.date} />
        </Field>
      </div>
      <div className="checks">
        <label className="check">
          <input type="checkbox" checked={d.tenantPresent} onChange={(e) => set("tenantPresent", e.target.checked)} />
          <span className="check-box" aria-hidden="true"><IconCheck size={14} /></span>
          <span className="check-text"><span className="check-label">Tenant present for the inspection</span><span className="check-hint">Untick if the inspection is done without the tenant.</span></span>
        </label>
      </div>
      {r.type === "out" && (
        <Field id="fwd" label="Tenant forwarding address" optional>
          <input id="fwd" type="text" value={d.forwardingAddress} onChange={(e) => set("forwardingAddress", e.target.value)} />
        </Field>
      )}
    </div>
  );
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" className="stepper-btn" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={`Fewer ${label.toLowerCase()}`}>−</button>
      <span className="stepper-val tnum" aria-live="polite">{value}</span>
      <button type="button" className="stepper-btn" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={`More ${label.toLowerCase()}`}>+</button>
    </div>
  );
}

function LayoutStep({ r, update, setDialog }: { r: Report; update: Upd; setDialog: (d: Dialog) => void }) {
  const count = (g: string) => r.rooms.filter((x) => x.group === g).length;
  const hasWork = (room: Room) => room.items.some((i) => i.cond || i.comment || i.photoIds.length || i.count) || !!room.notes || room.photoIds.length > 0;
  const confirmRemove = (room: Room, run: () => void) => {
    if (!hasWork(room)) return run();
    setDialog({ title: `Remove ${room.name}?`, body: <p>It already has marks or photos. They will be removed from this report.</p>,
      actions: [{ label: "Remove", kind: "alert", run: () => { run(); setDialog(null); } }, { label: "Keep it", kind: "quiet", run: () => setDialog(null) }] });
  };
  const setGroup = (g: string, n: number) => {
    const cur = r.rooms.filter((x) => x.group === g);
    if (n > cur.length) update((x) => { const ids = new Set(x.rooms.map((o) => o.id)); return { ...x, rooms: insertRoom(x.rooms, g).map((rm) => (x.baselineRef && !ids.has(rm.id) ? { ...rm, addedAtMoveOut: true } : rm)) }; });
    else { const last = cur[cur.length - 1]; confirmRemove(last, () => update((x) => ({ ...x, rooms: renumber(x.rooms.filter((y) => y.id !== last.id)) }))); }
  };
  const fixed = ["entry", "kitchen", "systems", "keys", "meters"];
  const toggles = ROOM_DEFS.filter((d) => !d.group?.match(/^(bedroom|bathroom)$/) && !fixed.includes(d.key));
  return (
    <div className="stack-lg">
      <p className="lede-sm">Set the rooms once. Each room becomes one screen of the checklist.</p>
      <div className="counts">
        <div className="count-row"><span className="count-label">Bedrooms</span><Stepper label="Bedrooms" value={count("bedroom")} min={0} max={8} onChange={(n) => setGroup("bedroom", n)} /></div>
        <div className="count-row"><span className="count-label">Bathrooms</span><Stepper label="Bathrooms" value={count("bathroom")} min={0} max={6} onChange={(n) => setGroup("bathroom", n)} /></div>
      </div>
      <fieldset className="group">
        <legend className="group-label">Other areas</legend>
        <div className="checks">
          {toggles.map((d) => {
            const room = r.rooms.find((x) => x.group === d.key);
            return (
              <label key={d.key} className="check">
                <input type="checkbox" checked={!!room} onChange={(e) => {
                  if (e.target.checked) update((x) => ({ ...x, rooms: insertRoom(x.rooms, d.key).map((rm) => (rm.group === d.key && x.baselineRef ? { ...rm, addedAtMoveOut: true } : rm)) }));
                  else if (room) confirmRemove(room, () => update((x) => ({ ...x, rooms: x.rooms.filter((y) => y.id !== room.id) })));
                }} />
                <span className="check-box" aria-hidden="true"><IconCheck size={14} /></span>
                <span className="check-text"><span className="check-label">{d.name}</span></span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p className="field-hint">Always included: Entry and hall, Kitchen, Systems and safety, Keys and remotes, Meter readings. Any item that does not apply can be marked N/A.</p>
    </div>
  );
}

interface RoomProps {
  r: Report; room: Room;
  patchRoom: (id: string, fn: (room: Room) => Room) => void;
  patchItem: (roomId: string, itemId: string, patch: Partial<Item>) => void;
  markAllGood: (roomId: string) => void;
  addPhotos: (files: File[], attach: (ids: string[]) => void) => Promise<void>;
  removePhoto: (id: string, detach: () => void) => void;
  onOpen: (id: string) => void;
}

function RoomStep({ r, room, patchRoom, patchItem, markAllGood, addPhotos, removePhoto, onOpen }: RoomProps) {
  const [newItem, setNewItem] = useState("");
  const left = unmarked(room);
  const compare = r.type === "out" && !!r.baselineRef;
  const addItem = () => { const l = newItem.trim(); if (!l) return; patchRoom(room.id, (x) => ({ ...x, items: [...x.items, makeItem(l, true)] })); setNewItem(""); };
  const attachTo = (itemId: string) => (ids: string[]) => patchRoom(room.id, (x) => ({ ...x, items: x.items.map((i) => (i.id === itemId ? { ...i, photoIds: [...i.photoIds, ...ids] } : i)) }));

  return (
    <div className="stack-lg">
      {room.addedAtMoveOut && <p className="note">This room was not on the move-in report.</p>}
      {room.kind === "std" && (
        <div className="allgood">
          <button type="button" className={`btn btn-block ${left ? "btn-quiet" : "btn-done"}`} onClick={() => markAllGood(room.id)} disabled={!left}>
            <IconCheck size={20} /><span>{!left ? "All items marked" : left === room.items.length ? "Mark all Good" : `Mark the other ${left} Good`}</span>
          </button>
          <p className="allgood-meta tnum">{room.items.length - left} of {room.items.length} marked{left && left < room.items.length ? " · tap any exception first, then mark the rest" : ""}</p>
        </div>
      )}
      {room.kind === "keys" && <p className="lede-sm">{compare ? "Count what the tenant hands back. The number issued at move-in is shown for each." : "Record how many of each the tenant receives."}</p>}
      {room.kind === "meters" && <p className="lede-sm">Enter each reading and take a photo of the meter face. If a utility is included in rent or not separately metered, say so in the note.</p>}

      <ul className="items">
        {room.items.map((it) => (
          <ItemRow key={it.id} it={it} room={room} compare={compare}
            onPatch={(p) => patchItem(room.id, it.id, p)}
            onRemove={it.custom ? () => patchRoom(room.id, (x) => ({ ...x, items: x.items.filter((i) => i.id !== it.id) })) : undefined}
            onAddPhotos={(files) => addPhotos(files, attachTo(it.id))}
            onRemovePhoto={(pid) => removePhoto(pid, () => patchItem(room.id, it.id, { photoIds: it.photoIds.filter((x) => x !== pid) }))}
            onOpen={onOpen} />
        ))}
      </ul>

      <div className="add-item">
        <label className="field-label" htmlFor={`add-${room.id}`}>Add an item</label>
        <div className="add-item-row">
          <input id={`add-${room.id}`} type="text" value={newItem} placeholder={room.kind === "keys" ? "e.g. Garage key" : "e.g. Wine fridge"} onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }} />
          <button type="button" className="btn btn-quiet" onClick={addItem} disabled={!newItem.trim()}>Add</button>
        </div>
      </div>

      {room.kind === "std" && (
        <>
          <Field id={`notes-${room.id}`} label="Room notes" optional>
            <textarea id={`notes-${room.id}`} className="ta-sm" value={room.notes} onChange={(e) => patchRoom(room.id, (x) => ({ ...x, notes: e.target.value }))} />
          </Field>
          <div>
            <p className="field-label">Overview photos <span className="field-optional">(optional)</span></p>
            <p className="field-hint">One or two wide shots of the whole room.</p>
            <PhotoStrip ids={room.photoIds} label={`${room.name} overview`} onOpen={onOpen}
              onAdd={(files) => addPhotos(files, (ids) => patchRoom(room.id, (x) => ({ ...x, photoIds: [...x.photoIds, ...ids] })))}
              onRemove={(pid) => removePhoto(pid, () => patchRoom(room.id, (x) => ({ ...x, photoIds: x.photoIds.filter((p) => p !== pid) })))} />
          </div>
        </>
      )}
    </div>
  );
}

function ItemRow({ it, room, compare, onPatch, onRemove, onAddPhotos, onRemovePhoto, onOpen }: {
  it: Item; room: Room; compare: boolean; onPatch: (p: Partial<Item>) => void; onRemove?: () => void;
  onAddPhotos: (f: File[]) => Promise<void>; onRemovePhoto: (id: string) => void; onOpen: (id: string) => void;
}) {
  const flagged = it.cond === "fair" || it.cond === "poor";
  const [open, setOpen] = useState(!!(it.comment || it.photoIds.length || it.cost));
  const ch = itemChange(it, room.kind);
  const show = open || flagged;
  const name = `c-${it.id}`;
  const b = it.before;

  const head = (
    <div className="item-head">
      <span className="item-label" id={`l-${it.id}`}>{it.label}</span>
      {ch === "worse" && <span className="flag flag-worse">{room.kind === "keys" ? "Not all returned" : "Worse than move-in"}</span>}
      {ch === "better" && <span className="flag">{room.kind === "keys" ? "More returned" : "Better than move-in"}</span>}
      {onRemove && <button type="button" className="link item-remove" onClick={onRemove} aria-label={`Remove ${it.label}`}>Remove</button>}
    </div>
  );
  const beforeLine = compare && b ? (
    <div className="before">
      <span className="before-k">Move-in</span>
      <span className="before-v">
        {room.kind === "keys" ? `${b.count || "0"} issued` : room.kind === "meters" ? (b.reading || "No reading") : condLabel(b.cond)}
        {b.issues.length > 0 && ` · ${b.issues.join(", ").toLowerCase()}`}{b.comment && ` · ${b.comment}`}
      </span>
      {b.photoIds.length > 0 && <span className="before-ph">{b.photoIds.slice(0, 3).map((p) => <Thumb key={p} id={p} alt={`${it.label} at move-in`} onOpen={onOpen} />)}</span>}
    </div>
  ) : compare && room.kind !== "meters" ? <div className="before"><span className="before-k">Move-in</span><span className="before-v">Not recorded</span></div> : null;

  const noteField = (
    <div className="field">
      <label className="sr-only" htmlFor={`n-${it.id}`}>Note for {it.label}</label>
      <textarea id={`n-${it.id}`} className="note-input" rows={it.comment.length > 34 ? 3 : 1} placeholder={flagged ? "Describe it: where, how big" : "Note"} value={it.comment} onChange={(e) => onPatch({ comment: e.target.value })} />
    </div>
  );

  if (room.kind === "keys") {
    const n = parseInt(it.count || "0", 10) || 0;
    return (
      <li className="item">
        {head}{beforeLine}
        <div className="key-row">
          <span className="key-k">{compare ? "Returned" : "Issued"}</span>
          <Stepper label={it.label} value={n} min={0} max={20} onChange={(v) => onPatch({ count: String(v) })} />
        </div>
        {show ? noteField : <button type="button" className="link item-more" onClick={() => setOpen(true)}>Add note</button>}
      </li>
    );
  }
  if (room.kind === "meters") {
    return (
      <li className="item">
        {head}{beforeLine}
        <div className="field">
          <label className="sr-only" htmlFor={`m-${it.id}`}>{it.label} reading</label>
          <input id={`m-${it.id}`} type="text" inputMode="decimal" placeholder="Reading" value={it.reading ?? ""} onChange={(e) => onPatch({ reading: e.target.value })} />
        </div>
        {noteField}
        <PhotoStrip compact ids={it.photoIds} label={it.label} onAdd={onAddPhotos} onRemove={onRemovePhoto} onOpen={onOpen} />
      </li>
    );
  }

  return (
    <li className={`item${flagged ? " is-flagged" : ""}`}>
      {head}{beforeLine}
      <div className="seg" role="radiogroup" aria-labelledby={`l-${it.id}`}>
        {CONDITIONS.map((c) => (
          <label key={c.value} className={`seg-opt seg-${c.value}`}>
            <input type="radio" name={name} value={c.value} checked={it.cond === c.value}
              onChange={() => onPatch({ cond: c.value, issues: c.value === "fair" || c.value === "poor" ? it.issues : [] })} />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
      {flagged && (
        <div className="chips chips-sm" role="group" aria-label={`What is wrong with ${it.label}`}>
          {ISSUES.map((s) => (
            <label key={s} className="chip">
              <input type="checkbox" checked={it.issues.includes(s)} onChange={() => onPatch({ issues: it.issues.includes(s) ? it.issues.filter((x) => x !== s) : [...it.issues, s] })} />
              <span className="chip-tick" aria-hidden="true"><IconCheck size={14} /></span>{s}
            </label>
          ))}
        </div>
      )}
      {show ? (
        <div className="item-extra">
          {noteField}
          {compare && (flagged || ch === "worse") && (
            <div className="field cost">
              <label className="field-label" htmlFor={`cost-${it.id}`}>Estimated cost <span className="field-optional">(optional, for the office)</span></label>
              <div className="cost-row"><span aria-hidden="true">$</span><input id={`cost-${it.id}`} type="text" inputMode="decimal" value={it.cost ?? ""} onChange={(e) => onPatch({ cost: e.target.value.replace(/[^0-9.]/g, "") })} /></div>
            </div>
          )}
          <PhotoStrip compact ids={it.photoIds} label={it.label} onAdd={onAddPhotos} onRemove={onRemovePhoto} onOpen={onOpen} />
        </div>
      ) : (
        <button type="button" className="link item-more" onClick={() => setOpen(true)}>Add note or photo</button>
      )}
    </li>
  );
}

function NotesStep({ r, update }: { r: Report; update: Upd }) {
  const set = (k: keyof Report["moveOut"], v: string) => update((cur) => ({ ...cur, moveOut: { ...cur.moveOut, [k]: v } }));
  const worse = r.rooms.flatMap((room) => room.items.filter((i) => itemChange(i, room.kind) === "worse").map((i) => `${room.name}: ${i.label}`));
  const total = r.rooms.flatMap((x) => x.items).reduce((s, i) => s + (parseFloat(i.cost || "") || 0), 0);
  return (
    <div className="stack-md">
      {r.baselineRef ? (
        <div className={`note${worse.length ? " note-alert" : ""}`}>
          <span>{worse.length ? `${worse.length} item${worse.length > 1 ? "s" : ""} recorded worse than at move-in: ${worse.join("; ")}.` : "No items recorded worse than at move-in."}</span>
        </div>
      ) : <p className="note">No move-in report was loaded, so there is no automatic comparison.</p>}
      <Field id="cmp" label="Comparison with move-in" optional hint="Overall differences from the move-in condition.">
        <textarea id="cmp" className="ta-sm" value={r.moveOut.comparison} onChange={(e) => set("comparison", e.target.value)} />
      </Field>
      <Field id="dmg" label="Damage noted" optional hint="What appears to be beyond normal wear and tear, in the inspector's view.">
        <textarea id="dmg" className="ta-sm" value={r.moveOut.damages} onChange={(e) => set("damages", e.target.value)} />
      </Field>
      <Field id="chg" label="Charges note" optional hint={`Repairs or cleaning the office may follow up on.${total ? ` Item estimates so far: $${total.toFixed(2)}.` : ""}`}>
        <textarea id="chg" className="ta-sm" value={r.moveOut.charges} onChange={(e) => set("charges", e.target.value)} />
      </Field>
    </div>
  );
}

function ReviewStep({ r, go }: { r: Report; go: (k: string) => void }) {
  const compare = r.type === "out" && !!r.baselineRef;
  const changes = r.rooms.flatMap((room) => room.items.filter((i) => itemChange(i, room.kind) === "worse").map((i) => ({ room, i })));
  const blanks = r.rooms.filter((x) => unmarked(x) > 0);
  const photos = r.rooms.reduce((s, x) => s + x.photoIds.length + x.items.reduce((a, i) => a + i.photoIds.length, 0), 0);
  return (
    <div className="stack-lg">
      {compare && (
        <section className={`review-block${changes.length ? " is-alert" : ""}`}>
          <div className="review-head"><h3>Changes since move-in ({changes.length})</h3></div>
          {changes.length ? (
            <ul className="change-list">
              {changes.map(({ room, i }) => (
                <li key={i.id}><button type="button" className="change-row" onClick={() => go(`room:${room.id}`)}>
                  <span className="change-what">{room.name} · {i.label}</span>
                  <span className="change-how">{room.kind === "keys" ? `${i.before?.count || 0} issued, ${i.count || 0} returned` : `${condLabel(i.before?.cond ?? "")} → ${condLabel(i.cond)}`}{i.comment ? ` · ${i.comment}` : ""}</span>
                </button></li>
              ))}
            </ul>
          ) : <p className="review-empty">No items recorded worse than at move-in.</p>}
        </section>
      )}
      {blanks.length > 0 && (
        <p className="note note-alert">Not marked: {blanks.map((x) => `${x.name} (${unmarked(x)})`).join(", ")}. They appear as “Not marked” in the report.</p>
      )}
      <section className="review-block">
        <div className="review-head"><h3>Details</h3><button type="button" className="link link-edit" onClick={() => go("details")}>Edit</button></div>
        <dl className="review-list">
          <Row k="Property" v={addressLine(r.details)} />
          <Row k="Tenant(s)" v={r.details.tenants} />
          <Row k="Inspected by" v={r.details.inspector} />
          <Row k="Date" v={fmtDate(r.details.date)} />
          <Row k="Tenant present" v={r.details.tenantPresent ? "Yes" : "No"} />
          {r.type === "out" && <Row k="Compared with" v={r.baselineRef ? r.baselineRef.id : "No move-in report"} />}
          <Row k="Photos" v={String(photos)} />
        </dl>
      </section>
      <section className="review-block">
        <div className="review-head"><h3>Rooms ({r.rooms.length})</h3><button type="button" className="link link-edit" onClick={() => go("layout")}>Edit rooms</button></div>
        <ul className="room-sum">
          {r.rooms.map((room) => {
            const c = (k: string) => room.items.filter((i) => i.cond === k).length;
            const meta = room.kind === "keys" ? room.items.filter((i) => i.count && i.count !== "0").map((i) => `${i.count} × ${i.label.toLowerCase()}`).join(", ") || "None recorded"
              : room.kind === "meters" ? room.items.map((i) => `${i.label}: ${i.reading || "-"}`).join(" · ")
              : [c("good") && `${c("good")} good`, c("fair") && `${c("fair")} fair`, c("poor") && `${c("poor")} poor`, c("na") && `${c("na")} n/a`, unmarked(room) && `${unmarked(room)} not marked`].filter(Boolean).join(" · ");
            const issues = room.items.filter((i) => i.cond === "fair" || i.cond === "poor");
            return (
              <li key={room.id}>
                <button type="button" className="room-sum-row" onClick={() => go(`room:${room.id}`)}>
                  <span className="room-sum-name">{room.name}</span>
                  <span className={`room-sum-meta${unmarked(room) ? " is-alert" : ""}`}>{meta}</span>
                  {issues.length > 0 && <span className="room-sum-issues">{issues.map((i) => `${i.label}: ${condLabel(i.cond)}${i.comment ? ` (${i.comment})` : ""}`).join("; ")}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {r.type === "out" && (
        <section className="review-block">
          <div className="review-head"><h3>Move-out notes</h3><button type="button" className="link link-edit" onClick={() => go("notes")}>Edit</button></div>
          <dl className="review-list">
            <Row k="Comparison" v={r.moveOut.comparison} />
            <Row k="Damage" v={r.moveOut.damages} />
            <Row k="Charges" v={r.moveOut.charges} />
          </dl>
        </section>
      )}
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) { return <div className="review-row"><dt>{k}</dt><dd>{v || "None"}</dd></div>; }

function SignStep({ r, update, errors }: { r: Report; update: Upd; errors: Record<string, string> }) {
  // keep one signature block per tenant name entered on the details screen
  useEffect(() => {
    const names = splitTenants(r.details.tenants);
    if (r.tenantSigs.length === names.length && r.landlordSig) return;
    update((cur) => ({
      ...cur,
      tenantSigs: names.map((n, i) => cur.tenantSigs[i] ?? { name: n, dataUrl: "", at: "", agree: "", reason: "" }),
      landlordSig: cur.landlordSig ?? { name: cur.details.inspector, dataUrl: "", at: "" },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setT = (i: number, p: Partial<TenantSignature>) => update((cur) => ({ ...cur, tenantSigs: cur.tenantSigs.map((s, j) => (j === i ? { ...s, ...p } : s)) }));
  const kind = typeLabel(r.type).toLowerCase();
  return (
    <div className="stack-lg">
      <p className="lede-sm">Hand the phone to each person. By signing, they confirm they took part in, or received, this {kind} inspection on {fmtDate(r.details.date)}. A tenant can record that they do not agree and say why.</p>
      <div className="checks">
        <label className="check">
          <input type="checkbox" checked={r.details.tenantPresent} onChange={(e) => update((cur) => ({ ...cur, details: { ...cur.details, tenantPresent: e.target.checked } }))} />
          <span className="check-box" aria-hidden="true"><IconCheck size={14} /></span>
          <span className="check-text"><span className="check-label">Tenant present</span><span className="check-hint">Untick to complete the report without a tenant signature.</span></span>
        </label>
      </div>
      {r.details.tenantPresent && r.tenantSigs.map((s, i) => (
        <section key={i} className="sign-block">
          <p className="group-label">Tenant{r.tenantSigs.length > 1 ? ` ${i + 1}` : ""}</p>
          <Field id={`tn${i}`} label="Name" error={errors[`tn${i}`]}>
            <input id={`tn${i}`} type="text" value={s.name} onChange={(e) => setT(i, { name: e.target.value })} />
          </Field>
          <fieldset className={`group${errors[`ta${i}`] ? " has-error" : ""}`}>
            <legend className="sr-only">Tenant response</legend>
            <div className="options">
              {([["agree", "I agree this report fairly represents the condition of the unit"], ["disagree", "I do not agree with this report"], ["declined", "Tenant declined to sign"]] as const).map(([v, l]) => (
                <label key={v} className="option option-tight">
                  <input type="radio" name={`agree${i}`} checked={s.agree === v} onChange={() => setT(i, { agree: v, ...(v === "declined" ? { dataUrl: "", at: "" } : {}) })} />
                  <span className="option-radio" aria-hidden="true" />
                  <span className="option-text"><span className="option-when">{l}</span></span>
                </label>
              ))}
            </div>
            {errors[`ta${i}`] && <p className="field-error">{errors[`ta${i}`]}</p>}
          </fieldset>
          {s.agree === "disagree" && (
            <Field id={`tr${i}`} label="Reasons">
              <textarea id={`tr${i}`} className="ta-sm" value={s.reason} onChange={(e) => setT(i, { reason: e.target.value })} />
            </Field>
          )}
          {s.agree !== "declined" && (
            <div className={errors[`ts${i}`] ? "has-error" : ""}>
              <SignaturePad label={`Tenant ${s.name}`} value={s.dataUrl} onChange={(d) => setT(i, { dataUrl: d, at: d ? new Date().toISOString() : "" })} />
              {errors[`ts${i}`] && <p className="field-error">{errors[`ts${i}`]}</p>}
            </div>
          )}
        </section>
      ))}
      {r.landlordSig && (
        <section className="sign-block">
          <p className="group-label">Landlord / agent, for {COMPANY}</p>
          <Field id="ln" label="Name" error={errors.ln}>
            <input id="ln" type="text" value={r.landlordSig.name} onChange={(e) => update((cur) => ({ ...cur, landlordSig: { ...cur.landlordSig!, name: e.target.value } }))} />
          </Field>
          <div className={errors.ls ? "has-error" : ""}>
            <SignaturePad label="Landlord or agent" value={r.landlordSig.dataUrl} onChange={(d) => update((cur) => ({ ...cur, landlordSig: { ...cur.landlordSig!, dataUrl: d, at: d ? new Date().toISOString() : "" } }))} />
            {errors.ls && <p className="field-error">{errors.ls}</p>}
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* done                                                                */
/* ------------------------------------------------------------------ */
function Done({ r, headingRef, onClose, onDelete, isSaved }: { r: Report; headingRef: React.RefObject<HTMLHeadingElement | null>; onClose: () => void; onDelete?: () => void; isSaved: boolean }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState<boolean | null>(null);
  const pdfRef = useRef<Blob | null>(null);
  const getPdf = async () => {
    if (pdfRef.current) return pdfRef.current;
    const { buildPdf } = await import("@/lib/pdf");
    pdfRef.current = await buildPdf(r);
    return pdfRef.current;
  };
  useEffect(() => { submitInspectionReport(r, null).then((x) => setSent(x.transmitted)); }, [r]);
  const names = async () => { const m = await import("@/lib/pdf"); return { pdf: m.pdfFileName(r), json: m.jsonFileName(r) }; };
  const download = (blob: Blob, name: string) => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setMsg("");
    try { await fn(); } catch (e) { if ((e as Error).name !== "AbortError") setMsg("That did not work on this device. Try Download PDF instead."); } finally { setBusy(""); }
  };
  const canShare = typeof navigator !== "undefined" && !!navigator.canShare && navigator.canShare({ files: [new File([""], "x.pdf", { type: "application/pdf" })] });
  const worse = r.rooms.flatMap((room) => room.items.filter((i) => itemChange(i, room.kind) === "worse")).length;

  return (
    <section className="confirm step" aria-labelledby="confirm-title">
      <p className="eyebrow eyebrow-accent"><IconCheck size={14} /> {isSaved ? "Saved report" : "Inspection complete"}</p>
      <h2 id="confirm-title" ref={headingRef} tabIndex={-1} className="confirm-title">{typeLabel(r.type)} report ready.</h2>
      <div className="ref">
        <p className="ref-label">Report ID</p>
        <p className="ref-value tnum">{r.id}</p>
      </div>
      <dl className="review-list confirm-summary">
        <div className="review-row"><dt>Property</dt><dd>{addressLine(r.details)}</dd></div>
        <div className="review-row"><dt>Tenant(s)</dt><dd>{r.details.tenants}</dd></div>
        <div className="review-row"><dt>Completed</dt><dd>{fmtDateTime(r.completedAt)}</dd></div>
        {r.type === "out" && <div className="review-row"><dt>Changes</dt><dd>{r.baselineRef ? `${worse} item${worse === 1 ? "" : "s"} worse than at move-in` : "No move-in report loaded"}</dd></div>}
      </dl>

      <div className="done-actions">
        <button type="button" className="btn btn-primary btn-block" disabled={!!busy} onClick={() => run("pdf", async () => download(await getPdf(), (await names()).pdf))}>
          {busy === "pdf" ? "Preparing PDF…" : "Download PDF"}
        </button>
        {canShare && (
          <button type="button" className="btn btn-quiet btn-block" disabled={!!busy} onClick={() => run("share", async () => {
            const f = new File([await getPdf()], (await names()).pdf, { type: "application/pdf" });
            await navigator.share({ files: [f], title: `${typeLabel(r.type)} inspection ${r.id}` });
          })}>{busy === "share" ? "Preparing…" : "Share PDF (email, text, Drive)"}</button>
        )}
        <button type="button" className="btn btn-quiet btn-block" disabled={!!busy} onClick={() => run("print", async () => {
          const url = URL.createObjectURL(await getPdf());
          const w = window.open(url, "_blank");
          if (!w) location.href = url;
        })}>{busy === "print" ? "Preparing…" : "Open PDF to print"}</button>
        {r.type === "in" && (
          <button type="button" className="btn btn-quiet btn-block" disabled={!!busy} onClick={() => run("json", async () => {
            const blob = new Blob([JSON.stringify(await buildReportFile(r))], { type: "application/json" });
            const name = (await names()).json;
            const f = new File([blob], name, { type: "application/json" });
            if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: name }); return; } catch (e) { if ((e as Error).name === "AbortError") return; } }
            download(blob, name);
          })}>{busy === "json" ? "Preparing…" : "Save move-in file for the move-out"}</button>
        )}
        {msg && <p className="field-error" role="alert">{msg}</p>}
      </div>

      {r.type === "in" && (
        <p className="note">A copy is kept under Saved on this device. For a move-out on another phone, open the move-in file saved above.</p>
      )}
      {sent === false && (
        <p className="preview-note">Not sent to the office. Nothing has left this device: download or share the PDF to keep a copy and give one to the tenant.</p>
      )}
      <div className="confirm-actions">
        {onDelete && <button type="button" className="btn btn-ghost" onClick={onDelete}>Delete from this device</button>}
        <button type="button" className="btn btn-primary" onClick={onClose}>{isSaved ? "Back to saved reports" : "Finish"}</button>
      </div>
    </section>
  );
}
