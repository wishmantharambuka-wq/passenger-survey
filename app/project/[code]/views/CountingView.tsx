"use client";

import { useMemo } from "react";
import JunctionPad, { fallbackArms, type JunctionArm } from "@/components/survey/JunctionPad";
import type { EdgeRow, Participant, Project } from "@/hooks/useProject";
import { bearing } from "@/lib/types/network";

/**
 * Wraps JunctionPad. Turns the participant's incident edges into JunctionArms
 * — each arm's bearing is the real compass direction the connected node lies
 * in, and its label is the connected node's code.
 */
export default function CountingView({
  project, myself, edges, participants,
}: {
  project: Project;
  myself: Participant;
  edges: EdgeRow[];
  participants: Participant[];
}) {
  const arms: JunctionArm[] = useMemo(() => {
    if (myself.lat == null || myself.lng == null) return fallbackArms(myself.junction_kind ?? "custom");
    const mine = edges.filter(
      (e) => e.from_user === myself.user_id || e.to_user === myself.user_id,
    );
    if (mine.length === 0) return fallbackArms(myself.junction_kind ?? "custom");

    return mine
      .map((e) => {
        const otherId = e.from_user === myself.user_id ? e.to_user : e.from_user;
        const other = participants.find((p) => p.user_id === otherId);
        if (other?.lat == null || other.lng == null) return null;
        const b = bearing(
          { lat: myself.lat!, lng: myself.lng! },
          { lat: other.lat, lng: other.lng },
        );
        return { id: e.id, bearing: b, label: other.code, connected: true };
      })
      .filter((a): a is JunctionArm => a !== null)
      .sort((a, b) => a.bearing - b.bearing);
  }, [edges, myself, participants]);

  return (
    <JunctionPad
      projectId={project.id}
      userId={myself.user_id}
      code={myself.code}
      kind={myself.junction_kind ?? "custom"}
      arms={arms}
    />
  );
}
