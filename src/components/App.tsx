"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Condition, InspectionType, Item, Report, Room, TenantSignature } from "@/lib/types";
import {
  CONDITIONS, COMPANY, ISSUES, MAIN_SITE, OFFICE_EMAIL, OFFICE_PHONE_DISPLAY, OFFICE_PHONE_TEL, PRIVACY_URL, ROOM_DEFS,
  addressLine, fmtDate, fmtDateTime, insertRoom, makeItem, newReport, renumber, typeLabel, unmarked,
} from "@/lib/template";
import { deletePhoto, deletePhotosFor, loadDraft, photoUrl, prunePhotos, putPhoto, requestPersistence, saveDraft } from "@/lib/store";
import { processPhoto } from "@/lib/photos";
import { emailInspectionReport, isEmail, parseRecipients } from "@/lib/email-report";
import PhotoStrip from "./PhotoStrip";
import SignaturePad from "./SignaturePad";
import { IconArrowLeft, IconArrowRight, IconCamera, IconCheck, IconClose, IconList, IconNote, IconPhone, IconShield } from "./icons";

/* ------------------------------------------------------------------ */
/* steps                                                               */
/* ------------------------------------------------------------------ */
interface Step { key: string; label: string }
const splitTenants = (s: string) => s.split(/\s*(?:,|&|\band\b|\n|;)\s*/i).map((x) => x.trim()).filter(Boolean).slice(0, 6);

function stepsFor(r: Report): Step[] {
  const names = splitTenants(r.details.tenants);
  return [
    { key: "details", label: "Inspection details" },
    { key: "layout", label: "Rooms in this unit" },
    ...r.rooms.map((x) => ({ key: `room:${x.id}`, label: x.name })),
    ...(r.type === "out" ? [{ key: "notes", label: "Move-out notes" }] : []),
    { key: "review", label: "Review" },
    ...(r.details.tenantPresent ? names.map((n, i) => ({ key: `sign:t${i}`, label: `Signature: ${n}` })) : []),
    { key: "sign:ll", label: "Signature: landlord / agent" },
    { key: "email", label: "Email report" },
  ];
}
/** One signature block per tenant name entered on the details screen, plus the landlord/agent. */
function syncSigs(r: Report): Report {
  const names = splitTenants(r.details.tenants);
  if (r.tenantSigs.length === names.length && r.landlordSig) return r;
  return {
    ...r,
    tenantSigs: names.map((n, i) => r.tenantSigs[i] ?? { name: n, dataUrl: "", at: "", agree: "", reason: "" }),
    landlordSig: r.landlordSig ?? { name: r.details.inspector, dataUrl: "", at: "" },
  };
}

function validateDetails(r: Report): Record<string, string> {
  const d = r.details, e: Record<string, string> = {};
  if (!d.address.trim()) e.address = "Enter the property address.";
  if (!d.tenants.trim()) e.tenants = "Enter the tenant name(s).";
  if (!d.inspector.trim()) e.inspector = "Enter who is inspecting.";
  if (!d.date) e.date = "Choose the date.";
  return e;
}
function validateSign(r: Report): Record<string, string> {
  const e: Record<string, string> = {};
  if (r.details.tenantPresent) {
    r.tenantSigs.forEach((s, i) => {
      if (!s.name.trim()) e[`tn${i}`] = "Enter the tenant's name.";
      if (!s.agree) e[`ta${i}`] = "Choose one.";
      if (s.agree !== "declined" && !s.dataUrl) e[`ts${i}`] = "Signature needed, or choose Declined.";
    });
  }
  if (!r.landlordSig?.name.trim()) e.ln = "Enter the landlord or agent's name.";
  if (!r.landlordSig?.dataUrl) e.ls = "Landlord or agent signature needed.";
  return e;
}
/** Error keys that belong to one signature screen. */
const signKeyOf = (errKey: string) => (/^t[nas](\d+)$/.test(errKey) ? `sign:t${errKey.replace(/^t[nas]/, "")}` : "sign:ll");
function validateEmail(r: Report): Record<string, string> {
  const e: Record<string, string> = {};
  const t = parseRecipients(r.email?.tenant ?? ""), o = parseRecipients(r.email?.office ?? "");
  if (t.some((x) => !isEmail(x))) e.emt = "Check the tenant email address.";
  if (o.some((x) => !isEmail(x))) e.emo = "Check the office email address.";
  if (!t.length && !o.length) e.emo = "Enter at least one email address.";
  return e;
}
/** Older drafts: v1 single "sign" screen, v2 move-out "baseline" step and finished reports. */
function migrate(d: Report): Report {
  let r: Report = { ...d, email: d.email ?? { tenant: "", office: OFFICE_EMAIL } };
  if (r.screen === "baseline") r = { ...r, screen: "details" };
  if (r.status === "complete" || r.screen === "done") r = { ...r, status: "draft", screen: "email" };
  if (r.screen === "sign") { r = syncSigs(r); r = { ...r, screen: stepsFor(r).find((s) => s.key.startsWith("sign:"))!.key }; }
  return r;
}
const errorsFor = (all: Record<string, string>, screen: string) => Object.fromEntries(Object.entries(all).filter(([k]) => signKeyOf(k) === screen));

type Dialog = { title: string; body: ReactNode; actions: { label: string; kind?: "primary" | "quiet" | "alert"; run: () => void }[] } | null;
type Opener = (id: string, remove?: () => void) => void;

/* ------------------------------------------------------------------ */
export default function App() {
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [home, setHome] = useState(true);
  const [emailNote, setEmailNote] = useState(""); // honest result of the last Email report press
  const [sending, setSending] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [lightbox, setLightbox] = useState<{ id: string; remove?: () => void } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"saved" | "error" | "">("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  /* ---------- boot: restore draft, service worker ---------- */
  useEffect(() => {
    const raw = loadDraft();
    const d = raw ? migrate(raw) : null;
    if (d) { setReport(d); setHome(false); }
    setReady(true);
    void prunePhotos(d?.id ?? null).catch(() => {});
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

  const update = useCallback((fn: (r: Report) => Report) => setReport((r) => (r ? fn(r) : r)), []);
  const screen = report?.screen ?? "";

  // signature screens need one block per tenant name (names can change on the details screen)
  useEffect(() => {
    if (report && report.status === "draft" && screen.startsWith("sign:") && syncSigs(report) !== report) update(syncSigs);
  }, [report, screen, update]);

  // once errors are on screen, re-check on every edit so fixed fields clear straight away
  useEffect(() => {
    if (!report || !Object.keys(errors).length) return;
    const e = report.screen === "details" ? validateDetails(report) : report.screen.startsWith("sign:") ? errorsFor(validateSign(report), report.screen) : report.screen === "email" ? validateEmail(report) : null;
    if (e && JSON.stringify(e) !== JSON.stringify(errors)) setErrors(e);
  }, [report, errors]);

  const steps = useMemo(() => (report ? stepsFor(report) : []), [report]);
  const stepIdx = Math.max(0, steps.findIndex((s) => s.key === screen));

  const go = (key: string) => {
    setErrors({}); setSheet(false); setEmailNote("");
    update((r) => ({ ...(key.startsWith("sign:") ? syncSigs(r) : r), screen: key }));
    setTimeout(() => headingRef.current?.focus({ preventScroll: true }), 30);
  };

  /* ---------- start / resume / exit ---------- */
  const begin = (type: InspectionType) => {
    const start = () => {
      if (report && report.status === "draft") void deletePhotosFor(report.id);
      const r = newReport(type);
      setReport(r); saveDraft(r); setHome(false); setDialog(null); setEmailNote("");
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
  const exitToHome = () => { flush(); setHome(true); setSheet(false); };

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
  const openPhoto: Opener = (id, remove) => setLightbox({ id, remove });

  /* ---------- room/item updates ---------- */
  const patchRoom = (roomId: string, fn: (room: Room) => Room) => update((r) => ({ ...r, rooms: r.rooms.map((x) => (x.id === roomId ? fn(x) : x)) }));
  const patchItem = (roomId: string, itemId: string, patch: Partial<Item>) =>
    patchRoom(roomId, (room) => ({ ...room, items: room.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }));
  const markAllGood = (roomId: string) => patchRoom(roomId, (room) => ({ ...room, items: room.items.map((i) => (i.cond ? i : { ...i, cond: "good" as Condition })) }));

  /* ---------- navigation with validation ---------- */
  const isLast = stepIdx === steps.length - 1;
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
    if (screen.startsWith("sign:")) {
      const e = errorsFor(validateSign(r), screen);
      if (Object.keys(e).length) { setErrors(e); return; }
      if (steps[stepIdx + 1]?.key === "email") return finishSigning();
    }
    if (screen === "email") return void sendEmail();
    if (stepIdx < steps.length - 1) go(steps[stepIdx + 1].key);
  };
  const back = () => { if (stepIdx > 0) go(steps[stepIdx - 1].key); else exitToHome(); };

  /* ---------- signatures done -> Email report (the only way out) ---------- */
  const signErrorsFirst = (r: Report) => {
    const e = validateSign(r);
    if (!Object.keys(e).length) return false;
    const first = signKeyOf(Object.keys(e)[0]);
    go(first); setTimeout(() => setErrors(errorsFor(e, first)), 40);
    return true;
  };
  const finishSigning = () => {
    if (!report || signErrorsFirst(report)) return;
    update((r) => ({ ...r, completedAt: r.completedAt || new Date().toISOString() }));
    go("email");
  };
  const sendEmail = async () => {
    if (!report || sending) return;
    const r = report;
    if (signErrorsFirst(r)) return;
    const e = validateEmail(r);
    setErrors(e);
    if (Object.keys(e).length) { setTimeout(() => document.querySelector<HTMLElement>(".has-error input")?.focus(), 20); return; }
    const to = parseRecipients(r.email?.tenant ?? "", r.email?.office ?? "");
    setSending(true); setEmailNote("");
    const res = await emailInspectionReport({ ...r, completedAt: r.completedAt || new Date().toISOString() }, to).finally(() => setSending(false));
    if (res.sent) {
      // the report has left the app: clear the autosaved draft and its photos
      saveDraft(null); void deletePhotosFor(r.id); setReport(null); setHome(true);
      setDialog({ title: "Report emailed", body: <p>{typeLabel(r.type)} report {r.id} went to {to.join(", ")}.</p>, actions: [{ label: "OK", kind: "primary", run: () => setDialog(null) }] });
      return;
    }
    update((cur) => ({ ...cur, email: { tenant: cur.email?.tenant ?? "", office: cur.email?.office ?? "", triedAt: new Date().toISOString() } }));
    setEmailNote(res.message);
  };

  if (!ready) return <div className="page app"><Masthead onHome={() => {}} /></div>;

  /* ---------- which view ---------- */
  const inFlow = !!report && !home && report.status === "draft";
  const curStep = steps[stepIdx];
  const curRoom = screen.startsWith("room:") ? report?.rooms.find((x) => `room:${x.id}` === screen) ?? null : null;
  const roomPos = curRoom && report ? report.rooms.indexOf(curRoom) + 1 : 0;
  const signSteps = steps.filter((s) => s.key.startsWith("sign:"));
  const signPos = signSteps.findIndex((s) => s.key === screen) + 1;
  const where = curRoom && report ? `Room ${roomPos} of ${report.rooms.length}` : signPos ? `Signature ${signPos} of ${signSteps.length}` : `Step ${stepIdx + 1} of ${steps.length}`;
  const nextLabel = isLast ? (sending ? "Sending…" : "Email report") : screen === "review" ? "Sign" : steps[stepIdx + 1]?.key === "review" ? "Review" : "Next";

  return (
    <div className={`page app${inFlow ? " in-flow" : ""}`}>
      <a className="skip" href="#main">Skip to the checklist</a>
      <Masthead onHome={exitToHome} onSteps={inFlow ? () => setSheet(true) : undefined} />
      {inFlow && <div className="progress-bar progress-top" aria-hidden="true"><span style={{ width: `${((stepIdx + 1) / steps.length) * 100}%` }} /></div>}

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
                <p className="rail-lede">Walk the unit room by room, mark each item, add photos, and both sides sign on the phone. The finished report is sent by email.</p>
                <ol className="rail-steps">
                  {["Details and rooms", "Room-by-room checklist", "Review", "Signatures", "Email report"].map((s, i) => (
                    <li key={s} className="rail-step"><span className="rail-num tnum">{String(i + 1).padStart(2, "0")}</span><span className="rail-label">{s}</span></li>
                  ))}
                </ol>
              </>
            )}
            <div className="rail-foot"><TrustLine /></div>
          </div>
        </aside>

        <main id="main" className="main" tabIndex={-1}>
          {!inFlow || !report ? (
            <Landing draft={report && report.status === "draft" ? report : null} onStart={begin} onResume={() => setHome(false)} />
          ) : (
            <form className="screen flow" noValidate onSubmit={(e) => { e.preventDefault(); next(); }}>
              <header className={`screen-head${curRoom ? " is-room" : ""}`}>
                <div className="screen-head-text">
                  <p className="screen-eyebrow tnum">{typeLabel(report.type)}{addressLine(report.details) ? ` · ${addressLine(report.details)}` : ""}</p>
                  <h2 id="step-title" ref={headingRef} tabIndex={-1} className="screen-title">{titleFor(report, curStep)}</h2>
                </div>
                {curRoom && curRoom.kind === "std" && <MarkAll room={curRoom} onMark={() => markAllGood(curRoom.id)} />}
              </header>

              <section key={screen} className={`screen-body step${curRoom ? " is-split" : ""}`} aria-labelledby="step-title">
                {screen === "details" && <DetailsStep r={report} update={update} errors={errors} />}
                {screen === "layout" && <LayoutStep r={report} update={update} setDialog={setDialog} />}
                {screen.startsWith("room:") && (curRoom
                  ? <RoomStep r={report} room={curRoom} patchRoom={patchRoom} patchItem={patchItem} addPhotos={addPhotos} removePhoto={removePhoto} onOpen={openPhoto} />
                  : <p className="lede-sm">This room was removed. <button type="button" className="link" onClick={() => go("layout")}>Back to rooms</button></p>)}
                {screen === "notes" && <NotesStep r={report} update={update} />}
                {screen === "review" && <ReviewStep r={report} go={go} />}
                {screen.startsWith("sign:") && <SignStep key={screen} r={report} screen={screen} update={update} errors={errors}
                  onNotPresent={() => { update((cur) => ({ ...cur, details: { ...cur.details, tenantPresent: false } })); go("sign:ll"); }} />}
                {screen === "email" && <EmailStep r={report} update={update} errors={errors} note={emailNote} />}
                {!steps.some((s) => s.key === screen) && <p className="lede-sm">This step is no longer in the report. <button type="button" className="link" onClick={() => go("review")}>Go to the review</button></p>}
              </section>

              <div className="bar">
                <div className="bar-inner">
                  <button type="button" className="btn btn-ghost bar-back" onClick={back}><IconArrowLeft size={20} /><span>Back</span></button>
                  <button type="button" className="bar-where" onClick={() => setSheet(true)} aria-label={`${where}. Show all steps`}>
                    <span className="bar-where-main tnum">{where}</span>
                    <span className={`bar-where-sub${saveState === "error" ? " is-alert" : ""}`} aria-live="polite">{saveState === "error" ? "Not saved: storage full" : "Progress saved"}</span>
                  </button>
                  <button type="submit" className="btn btn-primary bar-next" disabled={sending}>
                    <span>{nextLabel}</span>{!isLast && <IconArrowRight size={20} />}
                  </button>
                </div>
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

      {lightbox && <Lightbox id={lightbox.id} onClose={() => setLightbox(null)}
        onRemove={lightbox.remove ? () => { lightbox.remove!(); setLightbox(null); } : undefined} />}
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
  if (s.key === "email") return "Email report";
  if (s.key === "details") return "Inspection details";
  if (s.key === "layout") return "Rooms in this unit";
  if (s.key === "notes") return "Move-out notes";
  if (s.key === "review") return "Review";
  if (s.key === "sign:ll") return "Landlord / agent signs";
  if (s.key.startsWith("sign:t")) { const i = Number(s.key.slice(6)); return r.tenantSigs.length > 1 ? `Tenant ${i + 1} signs` : "Tenant signs"; }
  return s.label;
}

/* ------------------------------------------------------------------ */
/* shell pieces                                                        */
/* ------------------------------------------------------------------ */
function Masthead({ onHome, onSteps }: { onHome: () => void; onSteps?: () => void }) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <button type="button" className="brand brand-btn" onClick={onHome} aria-label="Inspections home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo.svg" alt="Stress Free Property Management" width={1280} height={240} />
        </button>
        <div className="masthead-tools">
          {onSteps && <button type="button" className="masthead-call masthead-steps" onClick={onSteps}><IconList size={18} /><span>Steps</span></button>}
          <a className="masthead-call" href={`tel:${OFFICE_PHONE_TEL}`} aria-label={`Call the office, ${OFFICE_PHONE_DISPLAY}`}>
            <IconPhone size={18} /><span className="masthead-call-text">{OFFICE_PHONE_DISPLAY}</span>
          </a>
        </div>
      </div>
    </header>
  );
}
function TrustLine() {
  return (
    <div>
      <p className="trust-row"><IconShield size={18} /> Progress autosaves while you work</p>
      <p className="trust-note">Nothing is uploaded while you inspect. A finished report leaves the app only by email.</p>
    </div>
  );
}
function Lightbox({ id, onClose, onRemove }: { id: string; onClose: () => void; onRemove?: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { photoUrl(id, false).then(setSrc); }, [id]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Photo" onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && <img src={src} alt="Inspection photo, full size" />}
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close photo"><IconClose size={22} /></button>
      {onRemove && <button type="button" className="btn btn-quiet lightbox-remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}>Remove this photo</button>}
    </div>
  );
}

function Field({ id, label, optional, error, className, children }: { id: string; label: string; optional?: boolean; error?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`field field-c${error ? " has-error" : ""}${className ? ` ${className}` : ""}`}>
      <label className="field-label" htmlFor={id}>{label}{optional && <span className="field-optional"> (optional)</span>}</label>
      {children}
      {error && <p className="field-error" id={`${id}-error`}>{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* landing                                                             */
/* ------------------------------------------------------------------ */
function Landing({ draft, onStart, onResume }: { draft: Report | null; onStart: (t: InspectionType) => void; onResume: () => void }) {
  const progress = draft ? (() => { const s = stepsFor(draft); const i = s.findIndex((x) => x.key === draft.screen); return `Step ${Math.max(1, i + 1)} of ${s.length}`; })() : "";
  return (
    <div className="screen landing step">
      <div className="landing-intro">
        <p className="eyebrow">Unit inspections</p>
        <h1 className="mobile-title">Condition inspection</h1>
      </div>

      {draft && (
        <button type="button" className="resume" onClick={onResume}>
          <span className="resume-text">
            <span className="eyebrow eyebrow-accent">Continue · {typeLabel(draft.type)}</span>
            <span className="resume-title">{addressLine(draft.details) || "No address yet"}</span>
            <span className="resume-meta tnum">{progress} · started {fmtDateTime(draft.createdAt)}</span>
          </span>
          <IconArrowRight size={22} />
        </button>
      )}

      <div className="big-choices">
        <button type="button" className="big-choice" onClick={() => onStart("in")}>
          <span className="big-kicker">Start of tenancy</span>
          <span className="big-label">Move In</span>
          <span className="big-sub">Record every room before the tenant moves in.</span>
          <span className="big-arrow" aria-hidden="true"><IconArrowRight size={26} /></span>
        </button>
        <button type="button" className="big-choice big-choice-alt" onClick={() => onStart("out")}>
          <span className="big-kicker">End of tenancy</span>
          <span className="big-label">Move Out</span>
          <span className="big-sub">Record every room when the tenant moves out.</span>
          <span className="big-arrow" aria-hidden="true"><IconArrowRight size={26} /></span>
        </button>
      </div>

      <p className="mobile-trust trust-row"><IconShield size={18} /> Finished reports are sent by email. <a href={PRIVACY_URL} target="_blank" rel="noopener">Privacy</a></p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* steps                                                               */
/* ------------------------------------------------------------------ */
type Upd = (fn: (r: Report) => Report) => void;

function DetailsStep({ r, update, errors }: { r: Report; update: Upd; errors: Record<string, string> }) {
  const d = r.details;
  const set = (k: keyof Report["details"], v: string | boolean) => update((cur) => ({ ...cur, details: { ...cur.details, [k]: v } }));
  return (
    <div className="form-grid">
      <Field id="address" label="Address" error={errors.address} className="span-2">
        <input id="address" type="text" autoComplete="street-address" placeholder="Street address" value={d.address} onChange={(e) => set("address", e.target.value)} aria-invalid={!!errors.address} />
      </Field>
      <Field id="unit" label="Unit" optional>
        <input id="unit" type="text" value={d.unit} onChange={(e) => set("unit", e.target.value)} />
      </Field>
      <Field id="city" label="City" optional>
        <input id="city" type="text" autoComplete="address-level2" value={d.city} onChange={(e) => set("city", e.target.value)} />
      </Field>
      <Field id="tenants" label="Tenant(s)" error={errors.tenants} className="span-2">
        <input id="tenants" type="text" autoComplete="off" placeholder="Names, separated by commas" value={d.tenants} onChange={(e) => set("tenants", e.target.value)} aria-invalid={!!errors.tenants} />
      </Field>
      <Field id="inspector" label="Inspector" error={errors.inspector}>
        <input id="inspector" type="text" autoComplete="name" value={d.inspector} onChange={(e) => set("inspector", e.target.value)} aria-invalid={!!errors.inspector} />
      </Field>
      <Field id="date" label="Date" error={errors.date}>
        <input id="date" type="date" value={d.date} onChange={(e) => set("date", e.target.value)} aria-invalid={!!errors.date} />
      </Field>
      {r.type === "out" && (
        <Field id="fwd" label="Tenant forwarding address" optional className="span-2">
          <input id="fwd" type="text" value={d.forwardingAddress} onChange={(e) => set("forwardingAddress", e.target.value)} />
        </Field>
      )}
      <label className="check check-row span-2">
        <input type="checkbox" checked={d.tenantPresent} onChange={(e) => set("tenantPresent", e.target.checked)} />
        <span className="check-box" aria-hidden="true"><IconCheck size={14} /></span>
        <span className="check-text"><span className="check-label">Tenant is here for the inspection</span></span>
      </label>
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
    if (n > cur.length) update((x) => ({ ...x, rooms: insertRoom(x.rooms, g) }));
    else { const last = cur[cur.length - 1]; confirmRemove(last, () => update((x) => ({ ...x, rooms: renumber(x.rooms.filter((y) => y.id !== last.id)) }))); }
  };
  const fixed = ["entry", "kitchen", "systems", "keys", "meters"];
  const toggles = ROOM_DEFS.filter((d) => !d.group?.match(/^(bedroom|bathroom)$/) && !fixed.includes(d.key));
  return (
    <div className="stack-sm">
      <div className="counts-grid">
        <div className="count-cell"><span className="count-label">Bedrooms</span><Stepper label="Bedrooms" value={count("bedroom")} min={0} max={8} onChange={(n) => setGroup("bedroom", n)} /></div>
        <div className="count-cell"><span className="count-label">Bathrooms</span><Stepper label="Bathrooms" value={count("bathroom")} min={0} max={6} onChange={(n) => setGroup("bathroom", n)} /></div>
      </div>
      <p className="group-label">Other areas</p>
      <div className="toggle-grid">
        {toggles.map((d) => {
          const room = r.rooms.find((x) => x.group === d.key);
          return (
            <label key={d.key} className="toggle">
              <input type="checkbox" checked={!!room} onChange={(e) => {
                if (e.target.checked) update((x) => ({ ...x, rooms: insertRoom(x.rooms, d.key) }));
                else if (room) confirmRemove(room, () => update((x) => ({ ...x, rooms: x.rooms.filter((y) => y.id !== room.id) })));
              }} />
              <span className="check-box" aria-hidden="true"><IconCheck size={14} /></span>
              <span className="toggle-label">{d.name.replace("Basement / storage / locker", "Storage / locker")}</span>
            </label>
          );
        })}
      </div>
      <p className="fine">Always included: entry, kitchen, systems and safety, keys, meters. {r.rooms.length} screens in total.</p>
    </div>
  );
}

function MarkAll({ room, onMark }: { room: Room; onMark: () => void }) {
  const left = unmarked(room);
  return (
    <div className="markall">
      <button type="button" className={`btn btn-sm ${left ? "btn-primary" : "btn-done"}`} onClick={onMark} disabled={!left}>
        <IconCheck size={18} /><span>{!left ? "All marked" : left === room.items.length ? "All Good" : `Rest Good (${left})`}</span>
      </button>
      <span className="markall-meta tnum">{room.items.length - left}/{room.items.length} marked</span>
    </div>
  );
}

interface RoomProps {
  r: Report; room: Room;
  patchRoom: (id: string, fn: (room: Room) => Room) => void;
  patchItem: (roomId: string, itemId: string, patch: Partial<Item>) => void;
  addPhotos: (files: File[], attach: (ids: string[]) => void) => Promise<void>;
  removePhoto: (id: string, detach: () => void) => void;
  onOpen: Opener;
}

function RoomStep({ r, room, patchRoom, patchItem, addPhotos, removePhoto, onOpen }: RoomProps) {
  const [newItem, setNewItem] = useState("");
  const [adding, setAdding] = useState(false);
  const [notesOpen, setNotesOpen] = useState(!!room.notes);
  const moveOut = r.type === "out";
  const addItem = () => { const l = newItem.trim(); if (!l) return; patchRoom(room.id, (x) => ({ ...x, items: [...x.items, makeItem(l, true)] })); setNewItem(""); setAdding(false); };
  const attachTo = (itemId: string) => (ids: string[]) => patchRoom(room.id, (x) => ({ ...x, items: x.items.map((i) => (i.id === itemId ? { ...i, photoIds: [...i.photoIds, ...ids] } : i)) }));

  return (
    <div className="room-scroll">
      {room.kind === "keys" && <p className="fine fine-top">{moveOut ? "How many of each the tenant hands back." : "How many of each the tenant receives."}</p>}
      {room.kind === "meters" && <p className="fine fine-top">Reading plus a photo of each meter. Not metered? Say so in a note.</p>}
      <ul className="rows">
        {room.items.map((it) => (
          <ItemRow key={it.id} it={it} room={room} moveOut={moveOut}
            onPatch={(p) => patchItem(room.id, it.id, p)}
            onRemove={it.custom ? () => patchRoom(room.id, (x) => ({ ...x, items: x.items.filter((i) => i.id !== it.id) })) : undefined}
            onAddPhotos={(files) => addPhotos(files, attachTo(it.id))}
            onRemovePhoto={(pid) => removePhoto(pid, () => patchRoom(room.id, (x) => ({ ...x, items: x.items.map((i) => (i.id === it.id ? { ...i, photoIds: i.photoIds.filter((p) => p !== pid) } : i)) })))}
            onOpen={onOpen} />
        ))}
      </ul>

      <div className="room-tools">
        {adding ? (
          <div className="add-item-row">
            <label className="sr-only" htmlFor={`add-${room.id}`}>New item</label>
            <input id={`add-${room.id}`} type="text" autoFocus value={newItem} placeholder={room.kind === "keys" ? "e.g. Garage key" : "e.g. Wine fridge"} onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }} />
            <button type="button" className="btn btn-quiet btn-sm" onClick={addItem} disabled={!newItem.trim()}>Add</button>
            <button type="button" className="icon-btn" onClick={() => { setAdding(false); setNewItem(""); }} aria-label="Cancel"><IconClose size={18} /></button>
          </div>
        ) : (
          <div className="tool-row">
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAdding(true)}>+ Item</button>
            {room.kind === "std" && <button type="button" className={`btn btn-quiet btn-sm${room.notes ? " has-value" : ""}`} onClick={() => setNotesOpen((o) => !o)}><IconNote size={18} /><span>Room note</span></button>}
            {room.kind === "std" && (
              <PhotoStrip inline ids={room.photoIds} label={`${room.name} overview`} buttonLabel="Room photo" onOpen={onOpen}
                onAdd={(files) => addPhotos(files, (ids) => patchRoom(room.id, (x) => ({ ...x, photoIds: [...x.photoIds, ...ids] })))}
                onRemove={(pid) => removePhoto(pid, () => patchRoom(room.id, (x) => ({ ...x, photoIds: x.photoIds.filter((p) => p !== pid) })))} />
            )}
          </div>
        )}
        {room.kind === "std" && notesOpen && (
          <div className="field">
            <label className="sr-only" htmlFor={`notes-${room.id}`}>Room notes</label>
            <textarea id={`notes-${room.id}`} className="ta-xs" placeholder="Notes for the whole room" value={room.notes} onChange={(e) => patchRoom(room.id, (x) => ({ ...x, notes: e.target.value }))} />
          </div>
        )}
      </div>
    </div>
  );
}

function ItemRow({ it, room, moveOut, onPatch, onRemove, onAddPhotos, onRemovePhoto, onOpen }: {
  it: Item; room: Room; moveOut: boolean; onPatch: (p: Partial<Item>) => void; onRemove?: () => void;
  onAddPhotos: (f: File[]) => Promise<void>; onRemovePhoto: (id: string) => void; onOpen: Opener;
}) {
  const flagged = it.cond === "fair" || it.cond === "poor";
  const [open, setOpen] = useState<boolean | null>(null);
  const show = open ?? flagged;
  const extras = it.photoIds.length + (it.comment ? 1 : 0);

  const label = (
    <button type="button" className="row-label" onClick={() => setOpen(!show)} aria-expanded={show} id={`l-${it.id}`}>
      <span className="row-name">{it.label}</span>
      {!show && extras > 0 && <span className="row-has" aria-label={`${extras} note or photo`}>{it.comment && <IconNote size={14} />}{it.photoIds.length > 0 && <IconCamera size={14} />}</span>}
    </button>
  );
  const note = (
    <>
      <label className="sr-only" htmlFor={`n-${it.id}`}>Note for {it.label}</label>
      <input id={`n-${it.id}`} className="row-note" type="text" enterKeyHint="done" placeholder={flagged ? "What and where" : "Note"} value={it.comment} onChange={(e) => onPatch({ comment: e.target.value })} />
    </>
  );
  const removeBtn = onRemove ? <button type="button" className="link row-remove" onClick={onRemove}>Remove item</button> : null;

  if (room.kind === "keys") {
    const n = parseInt(it.count || "0", 10) || 0;
    return (
      <li className="row">
        <div className="row-main">{label}<Stepper label={it.label} value={n} min={0} max={20} onChange={(v) => onPatch({ count: String(v) })} /></div>
        {show && <div className="row-extra"><div className="row-tools">{note}</div>{removeBtn}</div>}
      </li>
    );
  }
  if (room.kind === "meters") {
    return (
      <li className="row">
        <div className="row-main">
          {label}
          <label className="sr-only" htmlFor={`m-${it.id}`}>{it.label} reading</label>
          <input id={`m-${it.id}`} className="row-reading tnum" type="text" inputMode="decimal" placeholder="Reading" value={it.reading ?? ""} onChange={(e) => onPatch({ reading: e.target.value })} />
          <PhotoStrip inline ids={it.photoIds} label={it.label} onAdd={onAddPhotos} onRemove={onRemovePhoto} onOpen={onOpen} />
        </div>
        {show && <div className="row-extra"><div className="row-tools">{note}</div>{removeBtn}</div>}
      </li>
    );
  }

  return (
    <li className={`row${flagged ? " is-flagged" : ""}`}>
      <div className="row-main">
        {label}
        <div className="seg seg-inline" role="radiogroup" aria-labelledby={`l-${it.id}`}>
          {CONDITIONS.map((c) => (
            <label key={c.value} className={`seg-opt seg-${c.value}`}>
              <input type="radio" name={`c-${it.id}`} value={c.value} checked={it.cond === c.value}
                onChange={() => { onPatch({ cond: c.value, issues: c.value === "fair" || c.value === "poor" ? it.issues : [] }); if (c.value === "fair" || c.value === "poor") setOpen(null); }} />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      </div>
      {show && (
        <div className="row-extra">
          {flagged && (
            <div className="chips chips-row" role="group" aria-label={`What is wrong with ${it.label}`}>
              {ISSUES.map((s) => (
                <label key={s} className="chip">
                  <input type="checkbox" checked={it.issues.includes(s)} onChange={() => onPatch({ issues: it.issues.includes(s) ? it.issues.filter((x) => x !== s) : [...it.issues, s] })} />
                  <span className="chip-tick" aria-hidden="true"><IconCheck size={14} /></span>{s}
                </label>
              ))}
            </div>
          )}
          <div className="row-tools">
            {note}
            {moveOut && flagged && (
              <span className="row-cost"><span aria-hidden="true">$</span>
                <label className="sr-only" htmlFor={`cost-${it.id}`}>Estimated cost, optional, for the office</label>
                <input id={`cost-${it.id}`} type="text" inputMode="decimal" placeholder="Est." value={it.cost ?? ""} onChange={(e) => onPatch({ cost: e.target.value.replace(/[^0-9.]/g, "") })} />
              </span>
            )}
            <PhotoStrip inline ids={it.photoIds} label={it.label} onAdd={onAddPhotos} onRemove={onRemovePhoto} onOpen={onOpen} />
          </div>
          {removeBtn}
        </div>
      )}
    </li>
  );
}

function NotesStep({ r, update }: { r: Report; update: Upd }) {
  const set = (k: keyof Report["moveOut"], v: string) => update((cur) => ({ ...cur, moveOut: { ...cur.moveOut, [k]: v } }));
  const flagged = r.rooms.flatMap((room) => room.items.filter((i) => i.cond === "fair" || i.cond === "poor").map((i) => `${room.name}: ${i.label}`));
  const total = r.rooms.flatMap((x) => x.items).reduce((s, i) => s + (parseFloat(i.cost || "") || 0), 0);
  return (
    <div className="stack-sm">
      <p className={`note note-tight${flagged.length ? " note-alert" : ""}`}>
        {flagged.length ? `${flagged.length} Fair or Poor: ${flagged.join("; ")}.` : "Nothing marked Fair or Poor."}{total ? ` Estimates: $${total.toFixed(2)}.` : ""}
      </p>
      <Field id="cmp" label="Compared with move-in" optional>
        <textarea id="cmp" className="ta-xs" placeholder="Overall differences" value={r.moveOut.comparison} onChange={(e) => set("comparison", e.target.value)} />
      </Field>
      <Field id="dmg" label="Damage noted" optional>
        <textarea id="dmg" className="ta-xs" placeholder="Beyond normal wear, in the inspector's view" value={r.moveOut.damages} onChange={(e) => set("damages", e.target.value)} />
      </Field>
      <Field id="chg" label="Charges note" optional>
        <textarea id="chg" className="ta-xs" placeholder="Repairs or cleaning to follow up" value={r.moveOut.charges} onChange={(e) => set("charges", e.target.value)} />
      </Field>
    </div>
  );
}

function ReviewStep({ r, go }: { r: Report; go: (k: string) => void }) {
  const std = r.rooms.filter((x) => x.kind === "std");
  const total = std.reduce((s, x) => s + x.items.length, 0);
  const marked = total - std.reduce((s, x) => s + unmarked(x), 0);
  const flagged = std.reduce((s, x) => s + x.items.filter((i) => i.cond === "fair" || i.cond === "poor").length, 0);
  const photos = r.rooms.reduce((s, x) => s + x.photoIds.length + x.items.reduce((a, i) => a + i.photoIds.length, 0), 0);
  const blanks = r.rooms.filter((x) => unmarked(x) > 0);
  return (
    <div className="stack-sm">
      <p className="review-line tnum"><strong>{marked}</strong> of {total} items marked · <strong>{flagged}</strong> Fair or Poor · <strong>{photos}</strong> photo{photos === 1 ? "" : "s"}</p>
      {blanks.length > 0 && <p className="note note-tight note-alert">{total - marked} not marked. Tap a red room to finish it, or leave them as “Not marked”.</p>}
      <section className="review-block">
        <div className="review-head"><h3>Details</h3><button type="button" className="link link-edit" onClick={() => go("details")}>Edit</button></div>
        <p className="review-details">{addressLine(r.details)}<br /><span>{r.details.tenants} · {fmtDate(r.details.date)} · by {r.details.inspector}{r.details.tenantPresent ? "" : " · tenant not present"}</span></p>
      </section>
      <section className="review-block">
        <div className="review-head"><h3>Rooms ({r.rooms.length})</h3><button type="button" className="link link-edit" onClick={() => go("layout")}>Edit rooms</button></div>
        <ul className="room-grid">
          {r.rooms.map((room) => {
            const c = (k: string) => room.items.filter((i) => i.cond === k).length;
            const left = unmarked(room);
            const meta = room.kind === "keys" ? `${room.items.reduce((s, i) => s + (parseInt(i.count || "0", 10) || 0), 0)} keys/fobs`
              : room.kind === "meters" ? `${room.items.filter((i) => i.reading).length} of ${room.items.length} read`
              : left ? `${left} not marked` : c("fair") + c("poor") ? `${c("fair") + c("poor")} Fair/Poor` : "All Good";
            return (
              <li key={room.id}>
                <button type="button" className={`room-tile${left ? " is-alert" : c("fair") + c("poor") ? " is-flag" : ""}`} onClick={() => go(`room:${room.id}`)}>
                  <span className="room-tile-name">{room.name}</span>
                  <span className="room-tile-meta">{meta}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {r.type === "out" && (
        <section className="review-block">
          <div className="review-head"><h3>Move-out notes</h3><button type="button" className="link link-edit" onClick={() => go("notes")}>Edit</button></div>
          <p className="review-details"><span>{[r.moveOut.comparison, r.moveOut.damages, r.moveOut.charges].filter(Boolean).join(" · ") || "None"}</span></p>
        </section>
      )}
    </div>
  );
}

function SignStep({ r, screen, update, errors, onNotPresent }: { r: Report; screen: string; update: Upd; errors: Record<string, string>; onNotPresent: () => void }) {
  const kind = typeLabel(r.type).toLowerCase();
  if (screen === "sign:ll") {
    const s = r.landlordSig;
    if (!s) return null;
    return (
      <div className="sign-screen">
        <Field id="ln" label={`Name, for ${COMPANY.replace(" Inc.", "")}`} error={errors.ln}>
          <input id="ln" type="text" value={s.name} onChange={(e) => update((cur) => ({ ...cur, landlordSig: { ...cur.landlordSig!, name: e.target.value } }))} />
        </Field>
        {!r.details.tenantPresent && <p className="fine">Tenant not present: the report records that. <button type="button" className="link" onClick={() => update((cur) => ({ ...cur, details: { ...cur.details, tenantPresent: true } }))}>Tenant is here</button></p>}
        <div className={`sig-wrap${errors.ls ? " has-error" : ""}`}>
          <SignaturePad label="Landlord or agent" value={s.dataUrl} onChange={(d) => update((cur) => ({ ...cur, landlordSig: { ...cur.landlordSig!, dataUrl: d, at: d ? new Date().toISOString() : "" } }))} />
          {errors.ls && <p className="field-error">{errors.ls}</p>}
        </div>
      </div>
    );
  }
  const i = Number(screen.slice(6));
  const s = r.tenantSigs[i];
  if (!s) return null;
  const setT = (p: Partial<TenantSignature>) => update((cur) => ({ ...cur, tenantSigs: cur.tenantSigs.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
  return (
    <div className="sign-screen">
      <Field id={`tn${i}`} label="Tenant name" error={errors[`tn${i}`]}>
        <input id={`tn${i}`} type="text" value={s.name} onChange={(e) => setT({ name: e.target.value })} />
      </Field>
      <div className={`group${errors[`ta${i}`] ? " has-error" : ""}`}>
        <p className="sign-q" id={`q${i}`}>Does this {kind} report ({fmtDate(r.details.date)}) fairly show the unit&apos;s condition?</p>
        <div className="seg seg-3" role="radiogroup" aria-labelledby={`q${i}`}>
          {([["agree", "I agree"], ["disagree", "I disagree"], ["declined", "Won't sign"]] as const).map(([v, l]) => (
            <label key={v} className={`seg-opt seg-${v}`}>
              <input type="radio" name={`agree${i}`} checked={s.agree === v} onChange={() => setT({ agree: v, ...(v === "declined" ? { dataUrl: "", at: "" } : {}) })} />
              <span>{l}</span>
            </label>
          ))}
        </div>
        {errors[`ta${i}`] && <p className="field-error">{errors[`ta${i}`]}</p>}
      </div>
      {s.agree === "disagree" && (
        <div className="field">
          <label className="sr-only" htmlFor={`tr${i}`}>Reasons</label>
          <textarea id={`tr${i}`} className="ta-xs" placeholder="Why the tenant disagrees" value={s.reason} onChange={(e) => setT({ reason: e.target.value })} />
        </div>
      )}
      {s.agree === "declined" ? (
        <p className="note note-tight">Recorded as declined to sign. No signature needed.</p>
      ) : (
        <div className={`sig-wrap${errors[`ts${i}`] ? " has-error" : ""}`}>
          <SignaturePad label={`Tenant ${s.name}`} value={s.dataUrl} onChange={(d) => setT({ dataUrl: d, at: d ? new Date().toISOString() : "" })} />
          {errors[`ts${i}`] && <p className="field-error">{errors[`ts${i}`]}</p>}
        </div>
      )}
      {i === 0 && <button type="button" className="link fine-link" onClick={onNotPresent}>Tenant not here? Skip tenant signatures</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* email report: the only way a finished report leaves the app          */
/* ------------------------------------------------------------------ */
function EmailStep({ r, update, errors, note }: { r: Report; update: Upd; errors: Record<string, string>; note: string }) {
  const em = r.email ?? { tenant: "", office: OFFICE_EMAIL };
  const set = (k: "tenant" | "office", v: string) => update((cur) => ({ ...cur, email: { tenant: cur.email?.tenant ?? "", office: cur.email?.office ?? "", [k]: v } }));
  const std = r.rooms.filter((x) => x.kind === "std");
  const flagged = std.reduce((s, x) => s + x.items.filter((i) => i.cond === "fair" || i.cond === "poor").length, 0);
  const signed = r.tenantSigs.filter((s) => s.dataUrl).length + (r.landlordSig?.dataUrl ? 1 : 0);
  return (
    <div className="stack-sm">
      <p className="review-line tnum"><strong>{r.id}</strong> · {flagged} Fair or Poor · {signed} signature{signed === 1 ? "" : "s"}</p>
      <Field id="emt" label="Tenant email" optional error={errors.emt}>
        <input id="emt" type="email" multiple inputMode="email" autoComplete="off" placeholder="Separate several with commas" value={em.tenant} onChange={(e) => set("tenant", e.target.value)} aria-invalid={!!errors.emt} />
      </Field>
      <Field id="emo" label="Office / landlord email" error={errors.emo}>
        <input id="emo" type="email" multiple inputMode="email" autoComplete="off" value={em.office} onChange={(e) => set("office", e.target.value)} aria-invalid={!!errors.emo} />
      </Field>
      <p className="fine">The signed {typeLabel(r.type).toLowerCase()} report goes to every address above. Your work is kept until it is sent.</p>
      {note && (
        <p className="note note-tight note-alert" role="status">
          {note} Nothing was sent. Your report is kept here, so you can send it once email is turned on.
        </p>
      )}
    </div>
  );
}
