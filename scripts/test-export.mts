/**
 * Verifies the 30-second per-member time-series builder: correct number of
 * rows, correct per-direction counts per window, undo (delta -1) respected.
 * Run: node scripts/test-export.mts
 */
import { memberTimeSeriesCsv } from "../lib/export/csv.ts";

const project: any = {
  id: "p1", name: "Test", join_code: "123456", bin_seconds: 30,
  started_at: "2026-07-30T08:00:00.000Z",
  ended_at:   "2026-07-30T08:02:00.000Z",   // 2 minutes → 4 × 30s windows
  admin_id: "u1", status: "closed",
};
const participant: any = {
  project_id: "p1", user_id: "uA", join_order: 1, code: "A",
  junction_kind: "cross_junction", ready: true, lat: 6.9344, lng: 79.8428,
  gps_accuracy_m: 5, last_seen_at: null,
};

// window 0 (08:00:00-30): N×3, E×2 ; window 1: N×1 then undo N ; window 3: W×5
const t = (s: string) => `2026-07-30T08:0${s}.000Z`;
const taps: any = [
  { id:"1", user_id:"uA", to_arm:"N", delta:1, occurred_at:t("0:05"), received_at:t("0:05") },
  { id:"2", user_id:"uA", to_arm:"N", delta:1, occurred_at:t("0:10"), received_at:t("0:10") },
  { id:"3", user_id:"uA", to_arm:"N", delta:1, occurred_at:t("0:20"), received_at:t("0:20") },
  { id:"4", user_id:"uA", to_arm:"E", delta:1, occurred_at:t("0:25"), received_at:t("0:25") },
  { id:"5", user_id:"uA", to_arm:"E", delta:1, occurred_at:t("0:28"), received_at:t("0:28") },
  { id:"6", user_id:"uA", to_arm:"N", delta:1,  occurred_at:t("0:40"), received_at:t("0:40") },
  { id:"7", user_id:"uA", to_arm:"N", delta:-1, occurred_at:t("0:41"), received_at:t("0:41") }, // undo
  { id:"8", user_id:"uA", to_arm:"W", delta:1, occurred_at:t("1:35"), received_at:t("1:35") },
  { id:"9", user_id:"uA", to_arm:"W", delta:1, occurred_at:t("1:36"), received_at:t("1:36") },
  { id:"10",user_id:"uA", to_arm:"W", delta:1, occurred_at:t("1:37"), received_at:t("1:37") },
  { id:"11",user_id:"uA", to_arm:"W", delta:1, occurred_at:t("1:38"), received_at:t("1:38") },
  { id:"12",user_id:"uA", to_arm:"W", delta:1, occurred_at:t("1:39"), received_at:t("1:39") },
  // another member's tap must be ignored
  { id:"99",user_id:"uB", to_arm:"N", delta:1, occurred_at:t("0:05"), received_at:t("0:05") },
];

const csv = memberTimeSeriesCsv(project, participant, taps, 30);
console.log(csv.replace(/^\uFEFF/, ""));

// assertions
const lines = csv.replace(/^\uFEFF/, "").split("\n");
const dataRows = lines.filter((l) => /^\d+,\d\d:\d\d:\d\d,/.test(l));
const fail: string[] = [];
if (dataRows.length !== 4) fail.push(`expected 4 windows, got ${dataRows.length}`);
// header: period,time_start,time_end,N,E,S,W,total  (cross = N,E,S,W)
const header = lines.find((l) => l.startsWith("period,"))!;
if (header !== "period,time_start,time_end,N,E,S,W,total")
  fail.push(`header wrong: ${header}`);
// window 1 (row 0): N=3, E=2, total 5
if (!dataRows[0].endsWith(",3,2,0,0,5")) fail.push(`window1 wrong: ${dataRows[0]}`);
// window 2 (row 1): N 1 then undo → 0, total 0
if (!dataRows[1].endsWith(",0,0,0,0,0")) fail.push(`window2 wrong: ${dataRows[1]}`);
// window 4 (row 3): W=5, total 5
if (!dataRows[3].endsWith(",0,0,0,5,5")) fail.push(`window4 wrong: ${dataRows[3]}`);

// ── node isolation: each member's file must contain ONLY that member's data ──
// This is the regression guard for "clicked download A, got B's numbers".
const nodeB: any = {
  ...participant, user_id: "uB", code: "B", join_order: 2,
  junction_kind: "straight", lat: 6.9337, lng: 79.8452,
};
const csvA = memberTimeSeriesCsv(project, participant, taps, 30).replace(/^﻿/, "");
const csvB = memberTimeSeriesCsv(project, nodeB, taps, 30).replace(/^﻿/, "");

if (!csvA.startsWith("Node,A")) fail.push("A's file is not labelled Node,A");
if (!csvB.startsWith("Node,B")) fail.push("B's file is not labelled Node,B");
// A recorded 10 net taps (12 of A's rows, minus 1 undo pair); B recorded 1
const totalA = Number(csvA.split("\n").find((l) => l.startsWith("TOTAL,"))!.split(",").pop());
const totalB = Number(csvB.split("\n").find((l) => l.startsWith("TOTAL,"))!.split(",").pop());
if (totalA !== 10) fail.push(`A total expected 10, got ${totalA}`);
if (totalB !== 1)  fail.push(`B total expected 1 (only its own tap), got ${totalB}`);
if (csvA === csvB) fail.push("A and B produced identical files — data not isolated");
// B is a straight road: must expose N,S columns only, not A's cross layout
if (!csvB.includes("period,time_start,time_end,N,S,total"))
  fail.push("B's columns do not match its junction kind");
// B's own lat/lng, not A's
if (!csvB.includes("Latitude,6.9337")) fail.push("B's file has the wrong latitude");

console.log(fail.length ? "\nFAIL:\n" + fail.join("\n") : "\nALL ASSERTIONS PASSED");
process.exit(fail.length ? 1 : 0);
