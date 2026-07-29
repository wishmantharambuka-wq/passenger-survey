/**
 * Generates real per-member export files from a synthetic 3-minute station
 * survey, using the SAME memberTimeSeriesCsv the app ships. Open the output
 * .csv files in Excel to see the exact 30-second-row format.
 * Run: node scripts/sample-export.mts
 */
import { writeFileSync } from "node:fs";
import { memberTimeSeriesCsv } from "../lib/export/csv.ts";

const START = "2026-07-30T07:30:00.000Z";
const END   = "2026-07-30T07:33:00.000Z"; // 3 min → 6 windows of 30s

const project: any = {
  id: "demo", name: "Colombo Fort morning survey", join_code: "482913",
  bin_seconds: 30, started_at: START, ended_at: END,
  admin_id: "uA", status: "closed",
};

const nodes: any[] = [
  { user_id: "uA", code: "A", join_order: 1, junction_kind: "terminus",
    lat: 6.93440, lng: 79.84280 },
  { user_id: "uB", code: "B", join_order: 2, junction_kind: "straight",
    lat: 6.93370, lng: 79.84520 },
  { user_id: "uC", code: "C", join_order: 3, junction_kind: "cross_junction",
    lat: 6.93300, lng: 79.84760 },
].map((n) => ({ ...n, project_id: "demo", ready: true, gps_accuracy_m: 6, last_seen_at: null }));

// synthetic taps: a train pulse arrives ~07:30, flows A→B→C with a lag
const startMs = new Date(START).getTime();
let seed = 5;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const at = (sec: number) => new Date(startMs + sec * 1000).toISOString();

const taps: any[] = [];
let idc = 0;
const push = (user: string, arm: string, sec: number, n: number) => {
  for (let i = 0; i < n; i++)
    taps.push({ id: `t${idc++}`, user_id: user, to_arm: arm,
                delta: 1, occurred_at: at(sec + rnd() * 2), received_at: at(sec) });
};

// Node A (terminus, one exit "N"): heavy pulse 0-60s, tapering
push("uA", "N", 3, 40); push("uA", "N", 33, 55); push("uA", "N", 63, 25); push("uA", "N", 95, 8);
// Node B (straight N/S): people arrive ~40s later, most continue (N), some reverse (S)
push("uB", "N", 45, 30); push("uB", "S", 50, 4);
push("uB", "N", 75, 38); push("uB", "S", 78, 6);
push("uB", "N", 108, 16);
// Node C (4-way): arrive ~40s after B; split N (straight), E (turn), rest
push("uC", "N", 88, 18); push("uC", "E", 92, 9);
push("uC", "N", 120, 20); push("uC", "E", 123, 7); push("uC", "S", 125, 3);

for (const n of nodes) {
  const csv = memberTimeSeriesCsv(project, n, taps, 30);
  const file = `E:/2026/Passenger behaviour project/scripts/sample_Node_${n.code}.csv`;
  writeFileSync(file, csv, "utf8");
  console.log(`\n=== Node ${n.code} (${n.junction_kind}) ===`);
  console.log(csv.replace(/^\uFEFF/, ""));
}
