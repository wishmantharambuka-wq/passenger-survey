/**
 * Zero-dependency CSV export.
 *
 * Two files come out of one Export click:
 *   node_counts_<pin>_<stamp>.csv  — per-node summary an analyst opens first:
 *                                     lat/lng, junction kind, and one column per
 *                                     compass direction, plus totals.
 *   raw_taps_<pin>_<stamp>.csv     — every tap that hit the database, with
 *                                     timestamps, for reproducibility.
 *
 * Excel opens both directly (UTF-8 with BOM keeps names/labels correct).
 */

import { supabase } from "@/lib/supabase/client";
import { enumeratePaths, reconcile, toSeries, type LinkSpec, type RawBin }
  from "@/lib/flow/reconcile";
import type { ReconcileResult } from "@/lib/flow/types";
import type { EdgeRow, Participant, Project } from "@/hooks/useProject";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export interface TapRow {
  id: string;
  project_id: string;
  user_id: string;
  user_code: string;
  from_arm: string | null;
  to_arm: string;
  delta: number;
  occurred_at: string;
  received_at: string;
}

/**
 * Pulls tap_bins + raw taps for the project, builds both CSVs, and returns
 * them ready to hand to downloadCsv(). Called from the Done button.
 */
export async function fullExport(
  project: Project,
  participants: Participant[],
  edges: EdgeRow[],
) {
  const codeByUser = new Map(participants.map((p) => [p.user_id, p.code]));

  const [{ data: bins = [] }, { data: taps = [] }] = await Promise.all([
    supabase.from("tap_bins")
      .select("user_id, from_arm, to_arm, bin_start, count")
      .eq("project_id", project.id).order("bin_start"),
    supabase.from("taps")
      .select("id, project_id, user_id, from_arm, to_arm, delta, occurred_at, received_at")
      .eq("project_id", project.id).order("occurred_at"),
  ]);

  const rawBins: RawBin[] = (bins ?? []).map((r: any) => ({
    nodeCode: codeByUser.get(r.user_id) ?? r.user_id,
    fromApproach: r.from_arm || null,
    toApproach: r.to_arm,
    binStartMs: new Date(r.bin_start).getTime(),
    count: r.count,
  }));

  // Reconcile is opt-in — if the admin didn't draw any edges, we still
  // ship the per-direction summary, just without OD path estimates.
  let result: ReconcileResult | null = null;
  if (edges.length > 0) {
    const links: LinkSpec[] = edges.map((e) => ({
      from: codeByUser.get(e.from_user) ?? e.from_user,
      to:   codeByUser.get(e.to_user)   ?? e.to_user,
      departureApproach: e.id,
      lengthM: e.length_m,
    }));
    const paths = enumeratePaths(links, { maxDepth: 4 });
    if (rawBins.length) {
      result = reconcile(toSeries(rawBins, project.bin_seconds * 1000), links, paths);
    }
  }

  const tapRows: TapRow[] = (taps ?? []).map((r: any) => ({
    ...r, user_code: codeByUser.get(r.user_id) ?? r.user_id,
  }));

  return {
    summaryCsv: nodeSummaryCsv(project, participants, rawBins, result),
    tapsCsv:    tapsToCsv(tapRows),
    tapCount:   tapRows.length,
    result,
  };
}

/**
 * The primary spreadsheet. Three stacked sections so a coordinator can open
 * it in Excel and immediately see:
 *   1) project meta
 *   2) NODES: lat, lng, junction kind, one column per compass direction, total
 *   3) if edges were drawn — link retentions and every A→B→C / A→B→¬C
 *      truncation combination with 95% CI
 */
export function nodeSummaryCsv(
  project: Project,
  participants: Participant[],
  bins: RawBin[],
  result: ReconcileResult | null,
): string {
  const out: string[] = [];
  const row = (...xs: (string | number | null | undefined)[]) =>
    out.push(xs.map(escape).join(","));

  row("project", project.name);
  row("join_code", project.join_code);
  row("bin_seconds", project.bin_seconds);
  row("started_at", project.started_at ?? "");
  row("ended_at",   project.ended_at ?? new Date().toISOString());
  row("");

  // ── NODES: pivot the bins into a direction-wise table ───────────────
  row("# NODES");
  row("code", "user_id", "lat", "lng", "junction_kind",
      ...COMPASS, "total");

  const byNode = new Map<string, Record<string, number>>();
  for (const b of bins) {
    let m = byNode.get(b.nodeCode);
    if (!m) { m = {}; byNode.set(b.nodeCode, m); }
    m[b.toApproach] = (m[b.toApproach] ?? 0) + b.count;
  }

  for (const p of participants.slice().sort((a, b) => a.join_order - b.join_order)) {
    const counts = byNode.get(p.code) ?? {};
    let total = 0;
    const dirCells = COMPASS.map((d) => {
      const c = counts[d] ?? 0; total += c; return c;
    });
    // catch any non-compass arms (e.g. an edge id from an older run)
    for (const [k, v] of Object.entries(counts)) {
      if (!(COMPASS as readonly string[]).includes(k)) total += v;
    }
    row(p.code, p.user_id, p.lat ?? "", p.lng ?? "",
        p.junction_kind ?? "",
        ...dirCells, total);
  }

  // ── LINK RETENTIONS + PATH BREAKDOWN (only if reconcile ran) ────────
  if (result) {
    row("");
    row("# LINK RETENTIONS");
    row("from", "to", "retention_rho", "rho_ci_low", "rho_ci_high",
        "travel_time_seconds", "effective_speed_mps", "turn_share",
        "background_per_bin", "correlation", "departures", "arrivals",
        "confidence", "warnings");
    for (const l of result.links) {
      row(l.from, l.to, l.rho.toFixed(4), l.rhoLow.toFixed(4), l.rhoHigh.toFixed(4),
          l.tauSeconds, l.effectiveSpeedMps?.toFixed(3) ?? "",
          l.turnShare.toFixed(4), l.background.toFixed(2), l.correlation.toFixed(3),
          l.departures, l.arrivals, l.confidence, l.warnings.join(" | "));
    }
    row("");
    row("# PATH ESTIMATES (all combinations)");
    row("label", "path", "estimate", "ci_low", "ci_high", "confidence");
    for (const p of result.paths) {
      row(p.label, p.path.join(">"),
          Math.round(p.estimate), Math.round(p.ciLow), Math.round(p.ciHigh),
          p.confidence);
    }
  }
  return withBom(out.join("\n"));
}

export function tapsToCsv(rows: TapRow[]): string {
  const header = ["id","project_id","user_id","user_code",
                  "from_arm","to_arm","delta","occurred_at","received_at"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.id, r.project_id, r.user_id, r.user_code,
      r.from_arm ?? "", r.to_arm, r.delta, r.occurred_at, r.received_at,
    ].map(escape).join(","));
  }
  return withBom(lines.join("\n"));
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
