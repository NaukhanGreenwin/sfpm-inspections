import type { Report } from "./types";
import { uid } from "./template";

/** Start a move-out from a move-in: same address, tenants and room layout, with the move-in
 *  result attached to every item as `before`. Current marks start blank. */
export function applyBaseline(out: Report, mi: Report): Report {
  const rooms = mi.rooms.map((r) => ({
    ...r,
    id: uid("r"),
    notes: "",
    photoIds: [],
    items: r.items.map((it) => ({
      id: uid("i"),
      label: it.label,
      custom: it.custom,
      cond: "" as const,
      issues: [],
      comment: "",
      photoIds: [],
      before: { cond: it.cond, issues: it.issues, comment: it.comment, count: it.count, reading: it.reading, photoIds: it.photoIds },
    })),
  }));
  return {
    ...out,
    details: { ...out.details, address: mi.details.address, unit: mi.details.unit, city: mi.details.city, tenants: mi.details.tenants },
    rooms,
    baselineRef: { id: mi.id, date: mi.details.date, inspector: mi.details.inspector },
  };
}

export function detachBaseline(out: Report): Report {
  return { ...out, baselineRef: null, rooms: out.rooms.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, before: null })) })) };
}
