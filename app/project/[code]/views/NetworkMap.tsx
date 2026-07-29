"use client";

import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMap } from "react-leaflet";
import { useEffect } from "react";
import "leaflet/dist/leaflet.css";
import type { EdgeRow, Participant } from "@/hooks/useProject";
import type { LatLng } from "@/lib/types/network";

/** Live map for the admin. Everyone's GPS pin; tap to draw an edge. */
export default function NetworkMap({
  center, participants, edges, selected, onSelectParticipant,
}: {
  center: LatLng;
  participants: Participant[];
  edges: EdgeRow[];
  selected: string | null;
  onSelectParticipant: (userId: string) => void;
}) {
  const byId = new Map(participants.map((p) => [p.user_id, p]));

  return (
    <MapContainer center={[center.lat, center.lng]} zoom={17}
                  className="h-full w-full" preferCanvas zoomControl={false}>
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        attribution='&copy; OpenStreetMap &copy; CARTO'
        maxZoom={20}
      />
      <Recenter center={center} />

      {edges.map((e) => (
        <Polyline key={e.id}
                  positions={e.path.coordinates.map((c) => [c[1], c[0]])}
                  pathOptions={{ color: "#1E90FF", weight: 5, opacity: 0.75 }}>
          <Tooltip sticky>
            {byId.get(e.from_user)?.code}–{byId.get(e.to_user)?.code} · {Math.round(e.length_m)} m
          </Tooltip>
        </Polyline>
      ))}

      {participants.filter((p) => p.location).map((p) => {
        const [lng, lat] = p.location!.coordinates;
        const isSelected = selected === p.user_id;
        return (
          <CircleMarker key={p.user_id} center={[lat, lng]} radius={18}
                        pathOptions={{
                          color: isSelected ? "#FF7A18" : "#fff",
                          weight: isSelected ? 4 : 3,
                          fillColor: p.ready ? "#27AE60" : "#A9B0B0",
                          fillOpacity: 1,
                        }}
                        eventHandlers={{ click: () => onSelectParticipant(p.user_id) }}>
            <Tooltip permanent direction="center" className="!bg-transparent !border-0 !shadow-none !text-black !font-bold">
              {p.code}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

function Recenter({ center }: { center: LatLng }) {
  const map = useMap();
  useEffect(() => { map.setView([center.lat, center.lng]); }, [map, center.lat, center.lng]);
  return null;
}
