"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { EdgeRow, Participant, Project } from "@/hooks/useProject";
import { enumeratePaths, reconcile, toSeries, type LinkSpec, type RawBin } from "@/lib/flow/reconcile";
import type { ReconcileResult } from "@/lib/flow/types";
import {
  EXPORT_BIN_SECONDS, downloadMember, fetchProjectTaps,
  tapCountsByUser, type RawTap,
} from "@/lib/export/csv";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/**
 * Final view, shown to every member once the admin stops the project.
 *
 * Downloads are ONE BUTTON PER NODE, and one file per click. Firing several
 * downloads from a single click makes the browser drop all but one of them,
 * which showed up as "clicked A, got B".
 */
export default function ResultsView({
  project, participants, edges, amAdmin,
}: {
  project: Project;
  participants: Participant[];
  edges: EdgeRow[];
  amAdmin: boolean;
}) {
  const [taps, setTaps] = useState<RawTap[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);

  const ordered = useMemo(
    () => participants.slice().sort((a, b) => a.join_order - b.join_order),
    [participants],
  );

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      setTaps(await fetchProjectTaps(project.id));
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => tapCountsByUser(taps), [taps]);

  // Per-node, per-direction totals for the on-screen table.
  const dirTotals = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    for (const t of taps) {
      let row = m.get(t.user_id);
      if (!row) { row = {}; m.set(t.user_id, row); }
      row[t.to_arm] = (row[t.to_arm] ?? 0) + t.delta;
    }
    return m;
  }, [taps]);

  // OD reconciliation only means anything if the admin drew edges.
  const result: ReconcileResult | null = useMemo(() => {
    if (taps.length === 0 || edges.length === 0) return null;
    const codeByUser = new Map(participants.map((p) => [p.user_id, p.code]));
    const step = EXPORT_BIN_SECONDS * 1000;
    const bins: RawBin[] = taps.map((t) => {
      const ms = new Date(t.occurred_at ?? t.received_at).getTime();
      return {
        nodeCode: codeByUser.get(t.user_id) ?? t.user_id,
        fromApproach: null,
        toApproach: t.to_arm,
        binStartMs: Math.floor(ms / step) * step,
        count: t.delta,
      };
    });
    const links: LinkSpec[] = edges.map((e) => ({
      from: codeByUser.get(e.from_user) ?? e.from_user,
      to:   codeByUser.get(e.to_user)   ?? e.to_user,
      departureApproach: e.id,
      lengthM: e.length_m,
    }));
    return reconcile(toSeries(bins, step), links, enumeratePaths(links, { maxDepth: 4 }));
  }, [taps, edges, participants]);

  function save(p: Participant) {
    downloadMember(project, p, taps);
    setJustSaved(p.code);
    setTimeout(() => setJustSaved((c) => (c === p.code ? null : c)), 2500);
  }

  const totalTaps = taps.reduce((s, t) => s + t.delta, 0);

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-3xl flex-col gap-3 p-3">
      <div className="glass rounded-2xl px-4 py-3">
        <p className="text-xs uppercase tracking-wider text-ash">Session complete</p>
        <p className="text-lg font-semibold text-white">{project.name}</p>
        <p className="mt-1 text-xs text-ash">
          {totalTaps.toLocaleString()} counts · {participants.length} nodes · PIN {project.join_code}
        </p>
      </div>

      {/* ── DOWNLOADS: one button per node, visible to everyone ─────────── */}
      <section className="glass rounded-2xl p-4">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-xs uppercase tracking-wider text-ash">Download data</h3>
          <button onClick={() => void load()} disabled={loading}
                  className="ml-auto rounded-lg bg-white/8 px-3 py-1 text-[11px] text-ash disabled:opacity-40">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <p className="mb-3 text-[11px] text-ash">
          One file per node. Each row is a {EXPORT_BIN_SECONDS}-second period with
          counts per direction.
        </p>

        {err && (
          <p className="mb-3 rounded-xl bg-orange/15 px-3 py-2 text-xs text-orange">{err}</p>
        )}

        <div className="flex flex-col gap-2">
          {ordered.map((p) => {
            const n = counts[p.user_id] ?? 0;
            return (
              <button key={p.user_id} onClick={() => save(p)}
                      disabled={loading}
                      className="flex items-center gap-3 rounded-2xl border border-white/12 bg-white/5 px-4 py-3.5 text-left active:scale-[0.99] disabled:opacity-40">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-orange text-base font-bold text-black">
                  {p.code}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-white">
                    Download Node {p.code}
                  </span>
                  <span className="block text-[11px] text-ash">
                    {p.junction_kind ?? "—"} · {n.toLocaleString()} counts
                    {n === 0 && " · no data recorded"}
                  </span>
                </span>
                <span className={`ml-auto shrink-0 text-xs font-semibold ${
                  justSaved === p.code ? "text-green" : "text-blue"
                }`}>
                  {justSaved === p.code ? "✓ saved" : "CSV"}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── on-screen summary ──────────────────────────────────────────── */}
      {!loading && taps.length > 0 && (
        <section className="glass rounded-2xl p-4">
          <h3 className="mb-3 text-xs uppercase tracking-wider text-ash">
            Totals by node and direction
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="text-ash">
                <tr>
                  <th className="pb-2 pr-3 font-normal">node</th>
                  <th className="pb-2 pr-3 font-normal">lat</th>
                  <th className="pb-2 pr-3 font-normal">lng</th>
                  {COMPASS.map((d) =>
                    <th key={d} className="pb-2 pr-2 text-right font-normal">{d}</th>)}
                  <th className="pb-2 pl-3 text-right font-normal">total</th>
                </tr>
              </thead>
              <tbody className="text-white/90">
                {ordered.map((p) => {
                  const row = dirTotals.get(p.user_id) ?? {};
                  const total = Object.values(row).reduce((a, b) => a + b, 0);
                  return (
                    <tr key={p.user_id} className="border-t border-white/10">
                      <td className="py-2 pr-3 font-bold text-orange">{p.code}</td>
                      <td className="py-2 pr-3">{p.lat?.toFixed(5) ?? "–"}</td>
                      <td className="py-2 pr-3">{p.lng?.toFixed(5) ?? "–"}</td>
                      {COMPASS.map((d) => (
                        <td key={d} className="py-2 pr-2 text-right">
                          {row[d] ? row[d] : <span className="text-ash">·</span>}
                        </td>
                      ))}
                      <td className="py-2 pl-3 text-right font-bold">{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── OD analysis, only when edges were drawn ────────────────────── */}
      {result && (
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
      )}
    </main>
  );
}
