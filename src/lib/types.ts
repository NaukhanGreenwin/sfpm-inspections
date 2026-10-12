export type InspectionType = "in" | "out";
export type Condition = "good" | "fair" | "poor" | "na" | "";
export type RoomKind = "std" | "keys" | "meters";

/** What the move-in report recorded for an item (copied into a move-out report). */
export interface Baseline {
  cond: Condition;
  issues: string[];
  comment: string;
  count?: string; // keys issued
  reading?: string; // meters
  photoIds: string[]; // thumbnails available on this device
}

export interface Item {
  id: string;
  label: string;
  cond: Condition;
  issues: string[];
  comment: string;
  photoIds: string[];
  /** keys: number issued (move-in) or returned (move-out); meters: reading */
  count?: string;
  reading?: string;
  /** move-out only, optional */
  cost?: string;
  before?: Baseline | null;
  custom?: boolean;
}

export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  /** "bedroom" | "bathroom" etc. used for numbering and add/remove */
  group?: string;
  items: Item[];
  notes: string;
  photoIds: string[];
  /** set when the room was missing at move-in (added later) */
  addedAtMoveOut?: boolean;
}

export interface Signature {
  name: string;
  dataUrl: string; // PNG
  at: string; // ISO
}

export interface TenantSignature extends Signature {
  agree: "agree" | "disagree" | "declined" | "";
  reason: string;
}

export interface Details {
  address: string;
  unit: string;
  city: string;
  tenants: string;
  inspector: string;
  date: string; // yyyy-mm-dd
  tenantPresent: boolean;
  forwardingAddress: string; // move-out
}

export interface MoveOutNotes {
  comparison: string;
  damages: string;
  charges: string;
}

export interface Report {
  v: 1;
  id: string; // MI-261012-AB12 / MO-...
  type: InspectionType;
  status: "draft" | "complete";
  createdAt: string;
  completedAt: string;
  details: Details;
  rooms: Room[];
  moveOut: MoveOutNotes;
  /** move-out: the move-in report it was compared against */
  baselineRef: { id: string; date: string; inspector: string } | null;
  tenantSigs: TenantSignature[];
  landlordSig: Signature | null;
  /** UI position so a refresh returns to the same screen */
  screen: string;
}

export interface PhotoRecord {
  id: string;
  reportId: string;
  blob: Blob; // compressed, max 1600px
  thumb: Blob; // 320px
  w: number;
  h: number;
  takenAt: string;
}

/** The small portable file a move-in exports for the move-out. */
export interface ReportFile {
  kind: "sfpm-inspection";
  v: 1;
  report: Report;
  /** photo id -> 960px JPEG data URL (enough for the move-out screen and PDF) */
  thumbs: Record<string, string>;
  /** photo id -> ISO time the photo was added */
  taken?: Record<string, string>;
}
