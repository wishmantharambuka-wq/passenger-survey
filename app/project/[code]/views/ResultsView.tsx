"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { EdgeRow, Participant, Project } from "@/hooks/useProject";
import { enumeratePaths, reconcile, toSeries, type LinkSpec, type RawBin } from "@/lib/flow/reconcile";
import type { ReconcileResult } from "@/lib/flow/types";
import { downloadCsv, exportPerMember } from "@/lib/export/csv";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/**
 * Final view. Shows what everybody counted and offers an Export button that
 * downloads the same two CSVs the admin's Done button did — so if someone
 * missed it or wants a fresh copy, this is the recovery path.
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
  const [totalTaps, setTotalTaps] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const codeByUser = useMemo(
    () => new Map(participants.map((p) => [p.user_id, p.code])),
    [participants],
  );

  useEffect(() => {
    (async () => {
      const [{ data: b }, { count }] = await Promise.all([
        supabase.from("tap_bins")
          .select("user_id, from_arm, to_arm, bin_start, count")
          .eq("project_id", project.id).order("bin_start"),
        supabase.from("taps")
          .select("id", { count: "exact", head: true })
          .eq("project_id", project.id),
      ]);
      setBins((b ?? []).map((r: any) => ({
        nodeCode: codeByUser.get(r.user_id) ?? r.user_id,
        fromApproach: r.from_arm || null,
        toApproach: r.to_arm,
        binStartMs: new Date(r.bin_start).getTime(),
        count: r.count,
      })));
      setTotalTaps(count ?? 0);
      setLoading(false);
    })();
  }, [project.id, codeByUser]);

  const result: ReconcileResult | null = useMemo(() => {
    if (bins.length === 0 || edges.length === 0) return null;
    const links: LinkSpec[] = edges.map((e) => ({
      from: codeByUser.get(e.from_user) ?? e.from_user,
      to:   codeByUser.get(e.to_user)   ?? e.to_user,
      departureApproach: e.id,
      lengthM: e.length_m,
    }));
    const paths = enumeratePaths(links, { maxDepth: 4 });
    return reconcile(toSeries(bins, project.bin_seconds * 1000), links, paths);
  }, [bins, edges, codeByUser, project.bin_seconds]);

  const nodeDirCounts = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    for (const b of bins) {
      let row = m.get(b.nodeCode);
      if (!row) { row = {}; m.set(b.nodeCode, row); }
      row[b.toApproach] = (row[b.toApproach] ?? 0) + b.count;
    }
    return m;
  }, [bins]);

  async function exportAll() {
    setBusy(true);
    try {
      const files = await exportPerMember(project, participants);
      for (const f of files) downloadCsv(f.filename, f.csv);
    } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-3xl flex-col gap-3 p-3">
      <div className="glass rounded-2xl px-4 py-3">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-ash">Session complete</p>
            <p className="text-lg font-semibold text-white">{project.name}</p>
          </div>
          <button onClick={exportAll} disabled={busy}
                  className="ml-auto rounded-xl bg-green px-5 py-2.5 text-sm font-bold text-black disabled:opacity-40">
            {busy ? "Preparing…" : "Export (one file per node)"}
          </button>
        </div>
        <p className="mt-1 text-xs text-ash">
          {totalTaps.toLocaleString()} taps · {edges.length} edges · {participants.length} nodes
        </p>
      </div>

      {loading && <div className="glass rounded-2xl p-6 text-sm text-ash">Loading…</div>}
      {!loading && bins.length === 0 && (
        <div className="glass rounded-2xl p-6 text-sm text-orange">
          No taps recorded — nothing to summarise.
        </div>
      )}

      {/* NODE COUNTS with lat/lng and per-direction breakdown */}
      {!loading && bins.length > 0 && (
        <section className="glass rounded-2xl p-4">
          <h3 className="mb-3 text-xs uppercase tracking-wider text-ash">Node counts</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="text-ash">
                <tr>
                  <th className="pb-2 pr-3 font-normal">node</th>
                  <th className="pb-2 pr-3 font-normal">lat</th>
                  <th className="pb-2 pr-3 font-normal">lng</th>
                  <th className="pb-2 pr-3 font-normal">kind</th>
                  {COMPASS.map((d) =>
                    <th key={d} className="pb-2 pr-2 text-right font-normal">{d}</th>)}
                  <th className="pb-2 pl-3 text-right font-normal">total</th>
                </tr>
              </thead>
              <tbody className="text-white/90">
                {participants.slice().sort((a, b) => a.join_order - b.join_order).map((p) => {
                  const counts = nodeDirCounts.get(p.code) ?? {};
                  let total = 0;
                  const dirCells = COMPASS.map((d) => {
                    const c = counts[d] ?? 0; total += c; return c;
                  });
                  for (const [k, v] of Object.entries(counts)) {
                    if (!(COMPASS as readonly string[]).includes(k)) total += v;
                  }
                  return (
                    <tr key={p.user_id} className="border-t border-white/10">
                      <td className="py-2 pr-3 font-bold text-orange">{p.code}</td>
                      <td className="py-2 pr-3">{p.lat?.toFixed(5) ?? "–"}</td>
                      <td className="py-2 pr-3">{p.lng?.toFixed(5) ?? "–"}</td>
                      <td className="py-2 pr-3 text-ash">{p.junction_kind ?? "–"}</td>
                      {dirCells.map((c, i) =>
                        <td key={i} className="py-2 pr-2 text-right">{c || <span className="text-ash">·</span>}</td>)}
                      <td className="py-2 pl-3 text-right font-bold">{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* PATH / RETENTION ANALYSIS — only meaningful if edges were drawn */}
      {result && (
        <>
          <section className="glass rounded-2xl p-4">
            <h3 className="mb-3 text-xs uppercase tracking-wider text-ash">Link retentions</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs tabular-nums">
                <thead className="text-ash">
                  <tr>{["link","retention (95% CI)","walk","speed","turn","corr","conf"].map((h) =>
                    <th key={h} className="pb-2 pr-4 font-normal">{h}</th>)}</tr>
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

          <section className="glass rounded-2xl p-4">
            <h3 className="mb-1 text-xs uppercase tracking-wider text-ash">Route breakdown</h3>
            <p className="mb-3 text-[11px] text-ash">
              ¬X means &quot;reached the previous node but did not continue to X&quot;.
            </p>
            <ul className="space-y-1.5">
              {result.paths.slice().sort((a, b) => a.label.localeCompare(b.label)).map((p) => (
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
