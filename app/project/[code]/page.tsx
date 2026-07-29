"use client";

import { use } from "react";
import { useProject } from "@/hooks/useProject";
import Lobby from "./views/Lobby";
import AdminMap from "./views/AdminMap";
import CountingView from "./views/CountingView";
import ResultsView from "./views/ResultsView";
import WaitingView from "./views/WaitingView";

/**
 * The single screen the app spends most of its time on. Which VIEW renders is
 * decided by project.status + role, so when the admin advances a stage every
 * participant's device switches in lockstep via the realtime subscription.
 */
export default function ProjectPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { project, participants, edges, myself, amAdmin, error } = useProject(code);

  if (error) return <Message text={error} tone="error" />;
  if (!project) return <Message text="Loading project…" tone="quiet" />;
  if (!myself && !amAdmin) return <Message text="You aren't a participant in this project." tone="error" />;

  // LOBBY: PIN visible, roster forming, everyone picks their junction, admin starts mapping
  if (project.status === "lobby") {
    return <Lobby project={project} participants={participants} myself={myself} amAdmin={amAdmin} />;
  }

  // MAPPING: admin draws edges on live map; participants wait
  if (project.status === "mapping") {
    return amAdmin
      ? <AdminMap project={project} participants={participants} edges={edges} />
      : <WaitingView title="Admin is drawing the network" subtitle="Your junction will appear when the admin starts the project." />;
  }

  // ACTIVE: everyone counts
  if (project.status === "active") {
    return amAdmin && !myself
      ? <AdminMap project={project} participants={participants} edges={edges} liveTicker />
      : <CountingView project={project} myself={myself!} edges={edges} participants={participants} />;
  }

  // CLOSED: results + export
  return <ResultsView project={project} participants={participants} edges={edges} amAdmin={amAdmin} />;
}

function Message({ text, tone }: { text: string; tone: "quiet" | "error" }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center p-6">
      <div className={`glass rounded-2xl px-6 py-4 text-sm ${
        tone === "error" ? "text-orange" : "text-ash"
      }`}>{text}</div>
    </main>
  );
}
