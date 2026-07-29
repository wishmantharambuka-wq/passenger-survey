"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { ensureAnonUser } from "@/lib/supabase/auth";

type Mode = "home" | "create" | "join";

export default function Home() {
  const [mode, setMode] = useState<Mode>("home");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function create() {
    setBusy(true); setErr(null);
    try {
      await ensureAnonUser(name || undefined);
      const projectName = window.prompt("Project name?", "Colombo Station survey") ?? "Survey";
      const { data, error } = await supabase.rpc("create_project", { project_name: projectName });
      if (error) throw error;
      const row = (data as { project_id: string; join_code: string }[])[0];
      router.push(`/project/${row.join_code}`);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  async function join() {
    setBusy(true); setErr(null);
    try {
      await ensureAnonUser(name || undefined);
      const { data, error } = await supabase.rpc("join_project", { code });
      if (error) throw error;
      if (!(data as unknown[])?.length) throw new Error("no project returned");
      router.push(`/project/${code}`);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center p-6">
      <div className="glass w-full max-w-md rounded-3xl p-6 shadow-xl">
        <h1 className="text-2xl font-bold text-white">Passenger Behaviour Survey</h1>
        <p className="mt-1 text-sm text-ash">
          Real-time multi-surveyor pedestrian flow tracking.
        </p>

        {mode === "home" && (
          <div className="mt-6 flex flex-col gap-3">
            <button onClick={() => setMode("create")}
                    className="rounded-2xl bg-orange py-4 text-lg font-semibold text-black active:scale-[0.98]">
              Create a Project
            </button>
            <button onClick={() => setMode("join")}
                    className="rounded-2xl bg-blue py-4 text-lg font-semibold text-black active:scale-[0.98]">
              Join a Project
            </button>
          </div>
        )}

        {mode === "create" && (
          <div className="mt-6 flex flex-col gap-3">
            <label className="text-xs uppercase tracking-wider text-ash">Your name (optional)</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="e.g. Coordinator"
                   className="rounded-xl bg-white/8 px-4 py-3 text-white outline-none placeholder:text-ash/60 focus:ring-2 focus:ring-orange" />
            <button disabled={busy} onClick={create}
                    className="rounded-2xl bg-orange py-4 text-lg font-semibold text-black disabled:opacity-50">
              {busy ? "Creating…" : "Create & get PIN"}
            </button>
            <button onClick={() => setMode("home")} className="text-xs text-ash">← back</button>
          </div>
        )}

        {mode === "join" && (
          <div className="mt-6 flex flex-col gap-3">
            <label className="text-xs uppercase tracking-wider text-ash">Your name (optional)</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="e.g. Surveyor B"
                   className="rounded-xl bg-white/8 px-4 py-3 text-white outline-none placeholder:text-ash/60 focus:ring-2 focus:ring-blue" />
            <label className="mt-2 text-xs uppercase tracking-wider text-ash">6-digit PIN</label>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                   inputMode="numeric" pattern="[0-9]*" placeholder="••••••"
                   className="rounded-xl bg-white/8 px-4 py-4 text-center text-3xl font-bold tracking-[0.4em] text-white outline-none placeholder:text-ash/40 focus:ring-2 focus:ring-blue" />
            <button disabled={busy || code.length < 4} onClick={join}
                    className="rounded-2xl bg-blue py-4 text-lg font-semibold text-black disabled:opacity-50">
              {busy ? "Joining…" : "Join"}
            </button>
            <button onClick={() => setMode("home")} className="text-xs text-ash">← back</button>
          </div>
        )}

        {err && <p className="mt-4 rounded-xl bg-orange/15 px-3 py-2 text-xs text-orange">{err}</p>}
      </div>
    </main>
  );
}
