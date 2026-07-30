/**
 * Zero-dependency CSV export.
 *
 * The primary deliverable is a PER-MEMBER time series: one file per node, with
 * one row for every fixed time window (default 30s) showing how many people
 * that surveyor sent in each direction during that window. This is what an
 * analyst needs to see flow build and ebb over the session.
 *
 * Excel opens the files directly (UTF-8 BOM keeps labels correct).
 *
 * The export re-bins from the RAW `taps` table rather than the pre-aggregated
 * `tap_bins`, so the window size here is independent of the project's stored
 * bin_seconds — "a row every 30 seconds" holds regardless.
 */

import type { Participant, Project } from "@/hooks/useProject";

export const EXPORT_BIN_SECONDS = 30;

const COMPASS_ORDER = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Arm labels a node has, from the junction kind picked in the lobby. */
function armsForKind(kind: Participant["junction_kind"]): string[] {
  switch (kind) {
    case "straight":       return ["N", "S"];
    case "t_junction":     return ["N", "SE", "SW"];
    case "cross_junction": return ["N", "E", "S", "W"];
    case "terminus":       return ["N"];
    default:               return [...COMPASS_ORDER];
  }
}

export interface RawTap {
  id: string;
  user_id: string;
  to_arm: string;
  delta: number;
  occurred_at: string | null;
  received_at: string;
}

const PAGE = 1000;

/**
 * Fetch EVERY tap for the project.
 *
 * PostgREST caps a single response at 1000 rows, so a plain select silently
 * truncates a real survey (5 surveyors x 40 taps/min x 30 min is ~6000 rows)
 * and the export looks complete while missing most of the data. Page through
 * with .range() until a short page comes back.
 */
export async function fetchProjectTaps(projectId: string): Promise<RawTap[]> {
  // Lazy import keeps this module importable outside the browser (tests).
  const { supabase } = await import("@/lib/supabase/client");
  const all: RawTap[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("taps")
      .select("id, user_id, to_arm, delta, occurred_at, received_at")
      .eq("project_id", projectId)
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })     // stable tiebreak so paging can't skip/repeat
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`could not read taps: ${error.message}`);
    const rows = (data ?? []) as RawTap[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/**
 * Build one member's time-series CSV: a header block, then a row per
 * `binSeconds` window from session start to end, with a column per direction.
 */
export function memberTimeSeriesCsv(
  project: Project,
  participant: Participant,
  taps: RawTap[],
  binSeconds = EXPORT_BIN_SECONDS,
): string {
  const mine = taps.filter((t) => t.user_id === participant.user_id);

  // Column set: the node's own arms, plus any direction that actually shows up
  // in the data (defensive — covers older edge-id taps or custom nodes).
  const observed = new Set(mine.map((t) => t.to_arm));
  const cols = [
    ...armsForKind(participant.junction_kind),
    ...[...observed].filter((a) => !armsForKind(participant.junction_kind).includes(a)),
  ];

  // Time span. Prefer the project window; fall back to the data's own range.
  const times = mine
    .map((t) => new Date(t.occurred_at ?? t.received_at).getTime())
    .filter((n) => Number.isFinite(n));
  const startMs = project.started_at
    ? new Date(project.started_at).getTime()
    : times.length ? Math.min(...times) : Date.now();
  const endMs = project.ended_at
    ? new Date(project.ended_at).getTime()
    : times.length ? Math.max(...times) : startMs;

  const step = binSeconds * 1000;
  const nBins = Math.max(1, Math.ceil((endMs - startMs) / step));

  // grid[bin][arm] = net count
  const grid: Record<string, number>[] = Array.from({ length: nBins }, () => ({}));
  for (const t of mine) {
    const ms = new Date(t.occurred_at ?? t.received_at).getTime();
    const idx = Math.min(nBins - 1, Math.max(0, Math.floor((ms - startMs) / step)));
    grid[idx][t.to_arm] = (grid[idx][t.to_arm] ?? 0) + t.delta;
  }

  const out: string[] = [];
  const row = (...xs: (string | number | null | undefined)[]) =>
    out.push(xs.map(escape).join(","));

  row("Node", participant.code);
  row("Project", project.name);
  row("PIN", project.join_code);
  row("Junction type", participant.junction_kind ?? "");
  row("Latitude", participant.lat ?? "");
  row("Longitude", participant.lng ?? "");
  row("Window (seconds)", binSeconds);
  row("Session start", new Date(startMs).toISOString());
  row("Session end", new Date(endMs).toISOString());
  row("");

  // one row per time window
  row("period", "time_start", "time_end", ...cols, "total");
  let runningTotal = 0;
  for (let i = 0; i < nBins; i++) {
    const t0 = startMs + i * step;
    const t1 = Math.min(endMs, t0 + step);
    let binTotal = 0;
    const cells = cols.map((arm) => {
      const c = Math.max(0, grid[i][arm] ?? 0);
      binTotal += c;
      return c;
    });
    runningTotal += binTotal;
    row(i + 1, clock(t0), clock(t1), ...cells, binTotal);
  }
  row("");
  row("TOTAL", "", "", ...cols.map((arm) =>
    Math.max(0, mine.filter((t) => t.to_arm === arm).reduce((s, t) => s + t.delta, 0))),
    runningTotal);

  return withBom(out.join("\n"));
}

/** Filename for one node's export. */
export function memberFilename(project: Project, participant: Participant): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `Node_${participant.code}_${project.join_code}_${stamp}.csv`;
}

/**
 * Download exactly ONE node's file.
 *
 * Deliberately one file per click: browsers throttle and silently drop rapid
 * successive downloads, so the previous "loop over every member and download
 * each" approach delivered only whichever file survived the race — which
 * presented as "clicked A, got B".
 */
export function downloadMember(
  project: Project,
  participant: Participant,
  taps: RawTap[],
  binSeconds = EXPORT_BIN_SECONDS,
) {
  downloadCsv(
    memberFilename(project, participant),
    memberTimeSeriesCsv(project, participant, taps, binSeconds),
  );
}

/** Net tap count per node — shown beside each download button as a sanity check. */
export function tapCountsByUser(taps: RawTap[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of taps) out[t.user_id] = (out[t.user_id] ?? 0) + t.delta;
  return out;
}

// ── helpers ────────────────────────────────────────────────────────────────

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function escape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function withBom(s: string): string { return "﻿" + s; }

/** Trigger a download in the browser without adding any dependency. */
export function downloadCsv(name: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
