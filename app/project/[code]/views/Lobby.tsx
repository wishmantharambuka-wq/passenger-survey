"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { useGeolocation } from "@/hooks/useGeolocation";
import type { Participant, Project } from "@/hooks/useProject";

const KINDS: { id: Participant["junction_kind"]; label: string; hint: string }[] = [
  { id: "terminus",       label: "Terminus / Origin", hint: "one exit — e.g. station gate" },
  { id: "straight",       label: "Straight Road",     hint: "two directions" },
  { id: "t_junction",     label: "3-Way Junction",    hint: "three arms" },
  { id: "cross_junction", label: "4-Way Junction",    hint: "four arms" },
  { id: "custom",         label: "Custom",            hint: "5+ arms or unusual layout" },
];

export default function Lobby({
  project, participants, myself, amAdmin,
}: {
  project: Project;
  participants: Participant[];
  myself: Participant | null;
  amAdmin: boolean;
}) {
  const [kind, setKind] = useState<Participant["junction_kind"]>(myself?.junction_kind ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { fix, status, request } = useGeolocation();

  const allReady = participants.length >= 2 && participants.every((p) => p.ready);

  async function confirm() {
    if (!kind) { setErr("pick your junction kind first"); return; }
    if (!fix)  { setErr("share your location so the admin can see you on the map"); return; }
    setBusy(true); setErr(null);
    try {
      const { error } = await supabase.rpc("set_participant_ready", {
        p_project: project.id, p_kind: kind,
        p_lat: fix.lat, p_lng: fix.lng, p_acc: fix.accuracy,
      });
      if (error) throw error;
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  async function beginMapping() {
    setBusy(true); setErr(null);
    try {
      const { error } = await supabase.rpc("begin_mapping", { p_project: project.id });
      if (error) throw error;
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col gap-3 p-3">
      <div className="glass rounded-3xl px-5 py-4 text-center">
        <p className="text-xs uppercase tracking-wider text-ash">Join PIN</p>
        <p className="mt-1 select-all text-5xl font-black tracking-[0.3em] text-orange">
          {project.join_code}
        </p>
        <p className="mt-2 text-xs text-ash">Share this with your teammates</p>
      </div>

      <div className="glass rounded-2xl p-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="uppercase tracking-wider text-ash">Roster</span>
          <span className="text-white/80">{participants.length}/10</span>
        </div>
        <ul className="mt-2 grid grid-cols-2 gap-1.5">
          {participants.map((p) => (
            <li key={p.user_id} className={`flex items-center justify-between rounded-xl border border-white/10 px-3 py-2 text-sm ${
              p.ready ? "bg-green/10 text-white" : "bg-white/5 text-ash"
            }`}>
              <span className="font-bold text-orange">{p.code}</span>
              <span className="truncate">{p.junction_kind ?? "picking…"}</span>
              <span className={`ml-2 h-2 w-2 rounded-full ${p.ready ? "bg-green" : "bg-ash/40"}`} />
            </li>
          ))}
        </ul>
      </div>

      {!myself?.ready && (
        <div className="glass rounded-2xl p-3">
          <p className="px-2 pb-2 text-xs uppercase tracking-wider text-ash">
            Choose your junction type
          </p>
          <div className="flex flex-col gap-1.5">
            {KINDS.map((k) => (
              <button key={k.id} onClick={() => setKind(k.id)}
                      className={`flex items-center justify-between rounded-xl px-4 py-3 text-left transition ${
                        kind === k.id ? "bg-orange text-black" : "bg-white/5 text-white active:bg-white/10"
                      }`}>
                <span className="font-semibold">{k.label}</span>
                <span className={`text-xs ${kind === k.id ? "text-black/70" : "text-ash"}`}>{k.hint}</span>
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            {status !== "watching" ? (
              <button onClick={request}
                      className="flex-1 rounded-xl bg-blue py-3 text-sm font-semibold text-black">
                Share location
              </button>
            ) : (
              <div className="flex-1 rounded-xl bg-green/15 px-3 py-3 text-center text-xs text-green">
                GPS locked · ±{Math.round(fix?.accuracy ?? 0)} m
              </div>
            )}
            <button disabled={busy || !kind || !fix} onClick={confirm}
                    className="rounded-xl bg-orange px-5 py-3 text-sm font-bold text-black disabled:opacity-40">
              Confirm
            </button>
          </div>
        </div>
      )}

      {myself?.ready && (
        <div className="glass rounded-2xl p-4 text-center text-sm">
          <span className="text-green">✓ You&apos;re ready.</span>{" "}
          <span className="text-ash">
            Waiting for {participants.filter((p) => !p.ready).length} teammate(s).
          </span>
        </div>
      )}

      {amAdmin && (
        <button disabled={!allReady || busy} onClick={beginMapping}
                className="glass mt-auto rounded-2xl bg-orange py-4 text-lg font-bold text-black disabled:opacity-40">
          {allReady ? "Everyone ready — draw the network →" : `Waiting for ${participants.filter((p) => !p.ready).length}…`}
        </button>
      )}

      {err && <p className="rounded-xl bg-orange/15 px-3 py-2 text-xs text-orange">{err}</p>}
    </main>
  );
}
