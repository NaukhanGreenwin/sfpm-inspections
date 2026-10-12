export type InspectionType = "in" | "out";
export type Condition = "good" | "fair" | "poor" | "na" | "";
export type RoomKind = "std" | "keys" | "meters";

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
  /** move-out only, optional estimate for the office */
  cost?: string;
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

export interface EmailState {
  tenant: string; // comma-separated
  office: string; // landlord / office copy
  /** last time the inspector pressed Email report (ISO); sending is not wired yet */
  triedAt?: string;
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
  tenantSigs: TenantSignature[];
  landlordSig: Signature | null;
  /** Email report step (the only way a finished report leaves the app) */
  email?: EmailState;
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
