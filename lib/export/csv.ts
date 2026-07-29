/**
 * Zero-dependency CSV export.
 *
 * Emits two files from one Export click:
 *   raw_taps.csv    — every tap that hit the database, with timestamps
 *   flows.csv       — reconcile output: node totals, links, all path/truncation
 *                      combinations with 95% intervals
 *
 * Excel opens both directly (UTF-8 with BOM keeps names/labels correct).
 */

import type { ReconcileResult } from "@/lib/flow/types";

export interface TapRow {
  id: string;
  project_id: string;
  user_id: string;
  user_code: string;         // A / B / C
  from_arm: string | null;
  to_arm: string;
  delta: number;
  occurred_at: string;
  received_at: string;
}

export function tapsToCsv(rows: TapRow[]): string {
  const header = [
    "id", "project_id", "user_id", "user_code",
    "from_arm", "to_arm", "delta", "occurred_at", "received_at",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.id, r.project_id, r.user_id, r.user_code,
      r.from_arm ?? "", r.to_arm, r.delta, r.occurred_at, r.received_at,
    ].map(escape).join(","));
  }
  return withBom(lines.join("\n"));
}

/**
 * Flows CSV — three sections stacked so a single file opens cleanly in Excel:
 *  1) node totals              — "total volume passing Node A"
 *  2) direct link retentions   — A→B  ρ + CI
 *  3) path estimates           — A→B→C, A→B→¬C, A→B→C→¬D, … every combination
 */
export function flowsToCsv(result: ReconcileResult, projectId: string): string {
  const out: string[] = [];
  const row = (...xs: (string | number)[]) => out.push(xs.map(escape).join(","));

  row("project_id", projectId);
  row("computed_at", new Date().toISOString());
  row("");

  row("# NODE TOTALS");
  row("node", "total_volume", "outbound_breakdown");
  for (const n of result.nodes) {
    const breakdown = Object.entries(n.outboundByArm)
      .map(([arm, c]) => `${arm}:${c}`)
      .join(" | ");
    row(n.code, n.totalVolume, breakdown);
  }
  row("");

  row("# LINK FITS");
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
  row("label", "path", "reached_last", "diverted_at",
      "estimate", "ci_low", "ci_high", "confidence");
  for (const p of result.paths) {
    const isTruncation = p.label.includes("¬");
    row(
      p.label,
      p.path.join(">"),
      isTruncation ? p.path[p.path.length - 1] : p.path[p.path.length - 1],
      isTruncation ? p.label.split("¬")[1] : "",
      Math.round(p.estimate),
      Math.round(p.ciLow),
      Math.round(p.ciHigh),
      p.confidence,
    );
  }

  return withBom(out.join("\n"));
}

function escape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function withBom(s: string): string {
  return "﻿" + s;
}

/** Trigger a download in the browser without adding any dependency. */
export function downloadCsv(name: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
