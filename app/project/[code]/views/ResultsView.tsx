"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { EdgeRow, Participant, Project } from "@/hooks/useProject";
import { enumeratePaths, reconcile, toSeries, type LinkSpec, type RawBin } from "@/lib/flow/reconcile";
import type { ReconcileResult } from "@/lib/flow/types";
import { downloadCsv, flowsToCsv, tapsToCsv, type TapRow } from "@/lib/export/csv";

/**
 * The payoff view. Loads every tap_bin for the project, reconstructs the
 * network from the edges, enumerates every reachable path up to depth 4, and
 * runs the estimator. Then renders three sections:
 *   • node totals — "total volume passing Node A"
 *   • link retentions — A→B ρ with 95% CI, plus effective walking speed
 *   • path breakdown — every A, A→¬B, A→B, A→B→¬C, A→B→C, A→B→C→¬D, …
 * And an Export button that emits raw_taps.csv + flows.csv.
 */
export default function ResultsView({
  project, participants, edges, amAdmin,
}: {
  project: Project;
  participants: Participant[];
  edges: EdgeRow[];
  amAdmin: boolean;
}) {
  const [bins, setBins] = useState<RawBin[]>([]);
  const [taps, setTaps] = useState<TapRow[]>([]);
  const [loading, setLoading] = useState(true);

  const codeByUser = useMemo(
    () => new Map(participants.map((p) => [p.user_id, p.code])),
    [participants],
  );

  useEffect(() => {
    (async () => {
      const [{ data: b }, { data: t }] = await Promise.all([
        supabase.from("tap_bins")
          .select("user_id, from_arm, to_arm, bin_start, count")
          .eq("project_id", project.id).order("bin_start"),
        supabase.from("taps")
          .select("id, project_id, user_id, from_arm, to_arm, delta, occurred_at, received_at")
          .eq("project_id", project.id).order("occurred_at"),
      ]);

      setBins((b ?? []).map((r: any) => ({
        nodeCode: codeByUser.get(r.user_id) ?? r.user_id,
        fromApproach: r.from_arm || null,
        toApproach: r.to_arm,
        binStartMs: new Date(r.bin_start).getTime(),
        count: r.count,
      })));

      setTaps((t ?? []).map((r: any) => ({
        ...r, user_code: codeByUser.get(r.user_id) ?? r.user_id,
      })));

      setLoading(false);
    })();
  }, [project.id, codeByUser]);

  const result: ReconcileResult | null = useMemo(() => {
    if (bins.length === 0) return null;
    const links: LinkSpec[] = edges.map((e) => ({
      from: codeByUser.get(e.from_user) ?? e.from_user,
      to:   codeByUser.get(e.to_user)   ?? e.to_user,
      departureApproach: e.id,        // arm id == edge id in the tap UI
      lengthM: e.length_m,
    }));
    const paths = enumeratePaths(links, { maxDepth: 4 });
    return reconcile(toSeries(bins, project.bin_seconds * 1000), links, paths);
  }, [bins, edges, codeByUser, project.bin_seconds]);

  function exportAll() {
    if (!result) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadCsv(`raw_taps_${project.join_code}_${stamp}.csv`, tapsToCsv(taps));
    downloadCsv(`flows_${project.join_code}_${stamp}.csv`,   flowsToCsv(result, project.id));
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-3xl flex-col gap-3 p-3">
      <div className="glass rounded-2xl px-4 py-3">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-ash">Session complete</p>
            <p className="text-lg font-semibold text-white">{project.name}</p>
          </div>
          {amAdmin && (
            <button onClick={exportAll}
                    disabled={!result}
                    className="ml-auto rounded-xl bg-green px-5 py-2.5 text-sm font-bold text-black disabled:opacity-40">
              Export to Excel
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-ash">
          {taps.length.toLocaleString()} taps · {edges.length} edges · {participants.length} nodes
        </p>
      </div>

      {loading && <div className="glass rounded-2xl p-6 text-sm text-ash">Loading…</div>}
      {!loading && !result && (
        <div className="glass rounded-2xl p-6 text-sm text-orange">
          No taps recorded. Nothing to reconcile.
        </div>
      )}

      {result && (
        <>
          {/* NODE TOTALS */}
          <section className="glass rounded-2xl p-4">
            <h3 className="mb-3 text-xs uppercase tracking-wider text-ash">Total volume by node</h3>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {result.nodes.map((n) => (
                <div key={n.code} className="rounded-xl bg-white/5 p-3">
                  <div className="text-xs uppercase text-ash">Node {n.code}</div>
                  <div className="text-3xl font-bold tabular-nums text-orange">{n.totalVolume}</div>
                </div>
              ))}
            </div>
          </section>

          {/* LINK FITS */}
          <section className="glass rounded-2xl p-4">
            <h3 className="mb-3 text-xs uppercase tracking-wider text-ash">Link retentions</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs tabular-nums">
                <thead className="text-ash">
                  <tr>
                    {["link","retention (95% CI)","walk","speed","turn share","corr","conf."].map((h) =>
                      <th key={h} className="pb-2 pr-4 font-normal">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="text-white/90">
                  {result.links.map((l) => (
                    <tr key={`${l.from}${l.to}`} className="border-t border-white/10">
                      <td className="py-2 pr-4 font-medium">{l.from}→{l.to}</td>
                      <td className="py-2 pr-4 text-green">
                        {(l.rho*100).toFixed(0)}%
                        <span className="ml-1 text-ash">[{(l.rhoLow*100).toFixed(0)}, {(l.rhoHigh*100).toFixed(0)}]</span>
                      </td>
                      <td className="py-2 pr-4">{l.tauSeconds}s</td>
                      <td className="py-2 pr-4">{l.effectiveSpeedMps?.toFixed(2) ?? "–"} m/s</td>
                      <td className="py-2 pr-4">{(l.turnShare*100).toFixed(0)}%</td>
                      <td className={`py-2 pr-4 ${l.correlation < 0.3 ? "text-orange" : "text-blue"}`}>
                        {l.correlation.toFixed(2)}
                      </td>
                      <td className="py-2 pr-4">{l.confidence === "ok" ? "✓" : "low"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* PATH ESTIMATES — grouped by root */}
          <section className="glass rounded-2xl p-4">
            <h3 className="mb-1 text-xs uppercase tracking-wider text-ash">
              Route breakdown — every reached / diverted combination
            </h3>
            <p className="mb-3 text-[11px] text-ash">
              Truncations (¬X) are &quot;reached the previous node, but did not continue to X&quot;.
            </p>
            <ul className="space-y-1.5">
              {result.paths
                .slice()
                .sort((a, b) => a.label.localeCompare(b.label))
                .map((p) => (
                <li key={p.label} className="flex items-baseline gap-3 rounded-xl bg-white/5 px-3 py-2">
                  <span className="w-32 shrink-0 font-medium text-white">{p.label}</span>
                  <span className="text-xl font-bold tabular-nums text-orange">
                    {Math.round(p.estimate)}
                  </span>
                  <span className="text-xs tabular-nums text-ash">
                    [{Math.round(p.ciLow)}–{Math.round(p.ciHigh)}]
                  </span>
                  {p.confidence === "low_confidence" && (
                    <span className="ml-auto rounded-full bg-orange/20 px-2 py-0.5 text-[10px] text-orange">
                      low confidence
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
