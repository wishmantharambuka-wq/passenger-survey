"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export type ProjectStatus = "lobby" | "mapping" | "active" | "closed";

export interface Project {
  id: string; join_code: string; name: string;
  admin_id: string; status: ProjectStatus;
  bin_seconds: number; started_at: string | null; ended_at: string | null;
}

export interface Participant {
  project_id: string; user_id: string; join_order: number;
  code: string;
  junction_kind: "straight" | "t_junction" | "cross_junction" | "terminus" | "custom" | null;
  ready: boolean;
  location: { coordinates: [number, number] } | null;
  gps_accuracy_m: number | null;
  last_seen_at: string | null;
}

export interface EdgeRow {
  id: string; project_id: string;
  from_user: string; to_user: string;
  path: { coordinates: [number, number][] };
  length_m: number; bidirectional: boolean;
}

/**
 * Live view of one project. Subscribes to the three tables the flow depends
 * on — status changes, roster/readiness changes, and edge additions — so
 * every device transitions in lockstep when the admin advances a stage.
 */
export function useProject(joinCode: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [edges, setEdges] = useState<EdgeRow[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) { setError("not authenticated"); return; }
      if (!cancelled) setMe(auth.user.id);

      const { data: p, error: pe } = await supabase.from("projects")
        .select("*").eq("join_code", joinCode).maybeSingle();
      if (pe || !p) { if (!cancelled) setError(pe?.message ?? "project not found"); return; }
      if (!cancelled) setProject(p as Project);

      const [{ data: pp }, { data: ee }] = await Promise.all([
        supabase.from("project_participants").select("*")
          .eq("project_id", p.id).order("join_order"),
        supabase.from("project_edges").select("*").eq("project_id", p.id),
      ]);
      if (!cancelled) {
        setParticipants((pp ?? []) as Participant[]);
        setEdges((ee ?? []) as EdgeRow[]);
      }

      const ch = supabase
        .channel(`project:${p.id}:state`)
        .on("postgres_changes", { event: "*", schema: "public", table: "projects",
             filter: `id=eq.${p.id}` }, (payload) => {
          if (payload.new) setProject(payload.new as Project);
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "project_participants",
             filter: `project_id=eq.${p.id}` }, async () => {
          const { data } = await supabase.from("project_participants")
            .select("*").eq("project_id", p.id).order("join_order");
          setParticipants((data ?? []) as Participant[]);
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "project_edges",
             filter: `project_id=eq.${p.id}` }, async () => {
          const { data } = await supabase.from("project_edges")
            .select("*").eq("project_id", p.id);
          setEdges((data ?? []) as EdgeRow[]);
        })
        .subscribe();

      return () => { void supabase.removeChannel(ch); };
    })();

    return () => { cancelled = true; };
  }, [joinCode]);

  const myself = participants.find((p) => p.user_id === me) ?? null;
  const amAdmin = !!(project && me && project.admin_id === me);

  return { project, participants, edges, me, myself, amAdmin, error };
}
