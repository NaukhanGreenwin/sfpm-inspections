/**
 * submit-report.ts - the ONLY place a finished inspection would leave the device.
 *
 * TODO(wire-submit): this build intentionally sends NOTHING to a server. Reports stay on the
 * device (localStorage + IndexedDB) and leave only when the inspector downloads/shares the PDF
 * and the move-in .json file. To go live, replace the body of `submitInspectionReport` with:
 *   1. POST /api/inspections { report (JSON), pdf: true }  -> server validates, stores the record,
 *      returns one short-lived signed PUT URL per photo and one for the PDF (R2/S3, SSE, 15 min).
 *   2. PUT each photo blob (IndexedDB "photos" store) and the generated PDF to its signed URL.
 *   3. POST /api/inspections/{id}/finalize -> server files it to the unit record and emails
 *      the office and the tenant(s) a copy.
 *   4. Return { ok: true, transmitted: true }.
 * Also add the API origin to `connect-src` in the CSP (src/app/layout.tsx). The Done screen
 * already calls this function and shows its result, so nothing else in the UI needs to change.
 */
import type { Report } from "./types";

export interface SubmitResult { ok: boolean; transmitted: boolean }

export async function submitInspectionReport(report: Report, pdf: Blob | null): Promise<SubmitResult> {
  void report; void pdf; // TODO(wire-submit): send it. Until then nothing leaves the device.
  return { ok: true, transmitted: false };
}
