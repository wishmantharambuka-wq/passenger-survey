"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { EdgeRow, Participant, Project } from "@/hooks/useProject";

const NetworkMap = dynamic(() => import("./NetworkMap"), { ssr: false });

/**
 * Admin's mapping/active view. Live-updating map with every participant's GPS
 * pin; tap two pins to connect them with an edge; "Start Project" once you
 * have at least one edge.
 */
export default function AdminMap({
  project, participants, edges, liveTicker,
}: {
  project: Project;
  participants: Participant[];
  edges: EdgeRow[];
  liveTicker?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const center = useMemo(() => {
    const withLoc = participants.filter((p) => p.lat != null && p.lng != null);
    if (withLoc.length === 0) return { lat: 6.9271, lng: 79.8612 };
    const lat = withLoc.reduce((s, p) => s + p.lat!, 0) / withLoc.length;
    const lng = withLoc.reduce((s, p) => s + p.lng!, 0) / withLoc.length;
    return { lat, lng };
  }, [participants]);

  async function tapNode(userId: string) {
    if (project.status !== "mapping") return;
    if (!selected) { setSelected(userId); return; }
    if (selected === userId) { setSelected(null); return; }

    const from = participants.find((p) => p.user_id === selected)!;
    const to   = participants.find((p) => p.user_id === userId)!;
    if (from.lat == null || to.lat == null) { setErr("both endpoints need a GPS pin"); return; }

    try {
      setBusy(true); setErr(null);
      // WKT round-tripped as text — PostgREST parses it into the geography column
      const line = `LINESTRING(${from.lng} ${from.lat}, ${to.lng} ${to.lat})`;
      const { error } = await supabase.from("project_edges").insert({
        project_id: project.id,
        from_user: from.user_id,
        to_user:   to.user_id,
        path:      line,
      });
      if (error) throw error;
      setSelected(null);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  async function startProject() {
    try {
      setBusy(true); setErr(null);
      const { error } = await supabase.rpc("start_project", { p_project: project.id });
      if (error) throw error;
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  async function stopProject() {
    if (!window.confirm("Stop the project and freeze counting?")) return;
    try {
      setBusy(true); setErr(null);
      const { error } = await supabase.rpc("stop_project", { p_project: project.id });
      if (error) throw error;
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  return (
    <main className="flex h-[100dvh] flex-col gap-2 p-2 pb-[calc(0.5rem+18px)]">
      <div className="glass flex items-center gap-3 rounded-2xl px-4 py-2.5">
        <span className="text-sm font-semibold text-white">{project.name}</span>
        <span className="rounded-full bg-orange/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-orange">
          {project.status}
        </span>
        <span className="ml-auto text-xs text-ash">PIN {project.join_code}</span>
      </div>

      <div className="glass min-h-0 flex-1 overflow-hidden rounded-2xl">
        <NetworkMap
          center={center}
          participants={participants}
          edges={edges}
          selected={selected}
          onSelectParticipant={tapNode}
        />
      </div>

      <div className="glass rounded-2xl p-3">
        {project.status === "mapping" ? (
          <>
            <p className="text-xs text-ash">
              {selected
                ? `Tap another node to connect from ${participants.find((p) => p.user_id === selected)?.code}`
                : "Tap two nodes to draw a walking edge between them."}
            </p>
            <div className="mt-2 text-xs text-white/70">
              {edges.length} edge{edges.length === 1 ? "" : "s"} drawn
              {edges.length === 0 && (
                <span className="ml-2 text-ash">
                  (optional — needed only for path-flow analysis)
                </span>
              )}
            </div>
            <button disabled={busy} onClick={startProject}
                    className="mt-2 w-full rounded-xl bg-orange py-3.5 text-base font-bold text-black disabled:opacity-40">
              Start Project →
            </button>
          </>
        ) : project.status === "active" && liveTicker ? (
          <>
            <p className="text-xs text-ash">Counting live. Live rate per node appears here.</p>
            <button disabled={busy} onClick={stopProject}
                    className="mt-2 w-full rounded-xl bg-orange py-3.5 text-base font-bold text-black">
              Stop & Show Results
            </button>
          </>
        ) : null}
        {err && <p className="mt-2 rounded-xl bg-orange/15 px-3 py-2 text-xs text-orange">{err}</p>}
      </div>
    </main>
  );
}
