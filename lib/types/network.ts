export type LatLng = { lat: number; lng: number };

export type NodeKind = "straight" | "t_junction" | "cross_junction" | "terminus" | "custom";

/** How many approach arms a node kind has — drives the tally button layout. */
export const ARM_COUNT: Record<NodeKind, number> = {
  straight: 2,
  t_junction: 3,
  cross_junction: 4,
  terminus: 1,
  custom: 0,
};

export interface Approach {
  id: string;
  /** compass bearing out of the node, degrees from north */
  bearing: number;
  label: string;
  edgeId: string | null;
}

export interface SurveyNode {
  id: string;
  surveyId: string;
  code: string;
  label: string;
  kind: NodeKind;
  location: LatLng;
  approaches: Approach[];
}

export interface SurveyEdge {
  id: string;
  surveyId: string;
  fromNode: string;
  toNode: string;
  path: LatLng[];
  lengthM: number;
  streetName: string | null;
  bidirectional: boolean;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function polylineLength(path: LatLng[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += haversine(path[i - 1], path[i]);
  return d;
}

export function bearing(from: LatLng, to: LatLng): number {
  const y = Math.sin(rad(to.lng - from.lng)) * Math.cos(rad(to.lat));
  const x =
    Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) -
    Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(rad(to.lng - from.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function compassLabel(b: number): string {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round(b / 45) % 8];
}

/**
 * Rebuild a node's approach list from the edges incident on it. Placing a
 * 4-way junction and drawing four edges is all the configuration a surveyor's
 * tally UI needs — the buttons and their labels fall out of the geometry.
 */
export function deriveApproaches(node: SurveyNode, edges: SurveyEdge[]): Approach[] {
  return edges
    .filter((e) => e.fromNode === node.id || e.toNode === node.id)
    .map((e) => {
      const outward =
        e.fromNode === node.id ? e.path[1] ?? e.path.at(-1)! : e.path.at(-2) ?? e.path[0];
      const b = bearing(node.location, outward);
      return {
        id: e.id,
        bearing: b,
        label: e.streetName ?? `${compassLabel(b)} arm`,
        edgeId: e.id,
      };
    })
    .sort((a, b) => a.bearing - b.bearing);
}
