/**
 * email-report.ts - the ONLY way a finished inspection leaves the app (v3).
 *
 * There is no download, print, share, saved-reports list or move-in file any more. The last step of
 * both flows is "Email report": recipient fields + one button that calls `emailInspectionReport`.
 *
 * TODO(wire-email): NOT WIRED. This build sends nothing. `emailInspectionReport` returns
 * { sent: false, reason: "not-configured" } and the UI says "Email sending is not set up yet";
 * the inspection stays on the phone (localStorage draft + IndexedDB photos) until a send succeeds.
 *
 * To go live, pick one of these and replace the body below:
 *   A. Server-side PDF (preferred: consistent output, small upload from weak-signal units)
 *      1. POST {API}/inspections { report JSON, to: [...] } -> server validates the addresses,
 *         stores the record, returns one short-lived signed PUT URL per photo (R2/S3, SSE, 15 min).
 *      2. PUT each photo blob from IndexedDB ("photos" store, see photosFor(report.id)).
 *      3. POST {API}/inspections/{id}/send -> server renders the PDF and sends it through an email
 *         API (Microsoft Graph sendMail from the SFPM mailbox, or Postmark/SES/Resend) to every
 *         recipient, From: Stress Free Property Management, Reply-To: the office address.
 *   B. Client-side PDF (no server rendering)
 *      1. const { buildPdf, pdfFileName } = await import("./pdf"); const pdf = await buildPdf(report);
 *         (src/lib/pdf.ts is kept for this; it is not used anywhere in the UI today.)
 *      2. POST {API}/inspections/send as multipart { report JSON, to, pdf (pdfFileName(report)) }
 *         -> server relays it through the email API. Mind the size: photos make the PDF 2-15 MB.
 *   Either way: the API key lives on the server only, never in this static bundle; add the API
 *   origin to connect-src in the CSP (src/app/layout.tsx); return { sent: true } only after the
 *   email API accepted the message. On { sent: true } App.tsx clears the draft and its photos.
 */
import type { Report } from "./types";

export type EmailResult =
  | { sent: true; at: string }
  | { sent: false; reason: "not-configured" | "offline" | "failed"; message: string };

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

/** Split "a@x.ca, b@y.ca; c@z.ca" into addresses (deduped, lower-cased). */
export function parseRecipients(...fields: string[]): string[] {
  const all = fields.join(",").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return [...new Set(all)];
}
export const isEmail = (s: string) => EMAIL_RE.test(s.trim());

export async function emailInspectionReport(report: Report, to: string[]): Promise<EmailResult> {
  void report; void to; // TODO(wire-email): send it (see the header). Until then nothing leaves the phone.
  return { sent: false, reason: "not-configured", message: "Email sending is not set up yet." };
}
