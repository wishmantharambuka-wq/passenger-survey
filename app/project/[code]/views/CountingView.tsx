"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import JunctionPad, { fallbackArms } from "@/components/survey/JunctionPad";
import type { Participant, Project, EdgeRow } from "@/hooks/useProject";
import { flush } from "@/lib/offline/queue";

/**
 * The counting screen the participants live in.
 *
 * The junction diagram is driven purely by the kind they picked in the lobby
 * — 4-way gets 4 compass arms, 3-way gets 3, etc. Drawn edges do not label
 * the arms (the user asked for direction arrows, not "→B"/"→C").
 *
 * Done button:
 *   • ADMIN → confirms, closes the project, and pulls the Excel/CSV export
 *     down immediately from tap_bins.
 *   • PARTICIPANT → local "session complete" screen; the admin still owns
 *     project-wide closure.
 */
export default function CountingView({
  project, myself, edges, participants,
}: {
  project: Project;
  myself: Participant;
  edges: EdgeRow[];
  participants: Participant[];
}) {
  const router = useRouter();
  const [localDone, setLocalDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const amAdmin = project.admin_id === myself.user_id;

  const arms = useMemo(
    () => fallbackArms(myself.junction_kind ?? "custom"),
    [myself.junction_kind],
  );

  const stopProject = useCallback(async () => {
    if (!window.confirm("Stop counting for everyone and show the results?")) return;
    setBusy(true); setErr(null);
    try {
      // Push anything still queued on THIS device before freezing the session,
      // otherwise the last few taps would miss the export.
      await flush();

      const { error } = await supabase.rpc("stop_project", { p_project: project.id });
      if (error) throw error;

      // Everyone (including us) flips to ResultsView via the projects
      // Postgres-changes subscription. Downloads happen there — one button per
      // node, one file per click.
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setBusy(false); }
  }, [project.id]);

  if (localDone && !amAdmin) {
    return (
      <main className="grid min-h-[100dvh] place-items-center p-6">
        <div className="glass max-w-sm rounded-3xl p-8 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-green/20 text-green">
            <span className="text-3xl">✓</span>
          </div>
          <p className="mt-4 text-lg font-semibold text-white">You're done, Node {myself.code}</p>
          <p className="mt-1 text-sm text-ash">
            Waiting for the admin to close the project so results can be exported.
          </p>
          <button onClick={() => setLocalDone(false)}
                  className="mt-6 rounded-xl bg-white/8 px-5 py-2.5 text-sm text-ash">
            Resume counting
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      <JunctionPad
        projectId={project.id}
        userId={myself.user_id}
        code={myself.code}
        kind={myself.junction_kind ?? "custom"}
        arms={arms}
        onDone={
          amAdmin
            ? (busy ? undefined : stopProject)
            // flush first so this surveyor's last taps reach the server before
            // the admin closes the session
            : () => { void flush(); setLocalDone(true); }
        }
        doneLabel={amAdmin ? (busy ? "Stopping…" : "Done") : "Done"}
        doneVariant="primary"
      />
      {err && (
        <p className="fixed inset-x-3 bottom-24 z-50 rounded-xl bg-orange/20 px-3 py-2 text-center text-xs text-orange">
          {err}
        </p>
      )}
    </>
  );
}
