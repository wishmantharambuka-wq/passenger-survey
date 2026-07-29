/**
 * Synthetic validation of the flow estimator.
 *
 * Generates pulsed station-arrival data with KNOWN retention, turn-split and
 * travel-time parameters, then checks the algorithm recovers them from
 * anonymous screenline counts alone. Reports bias and CI coverage over many
 * replications — a point estimate that looks right once proves nothing.
 *
 * Run:  node scripts/verify-flow.mts        (Node 22+, no build step)
 */
import { reconcile, toSeries, type RawBin } from "../lib/flow/reconcile.ts";
import type { ReconcileResult } from "../lib/flow/types.ts";

const N = 180;                    // bins
const BIN_MS = 60_000;
const T0 = Date.UTC(2026, 6, 29, 7, 0, 0);

const TRUE = {
  rhoAB: 0.70, tauAB: 2,          // 70% of A's outbound flow reaches B, 2 min walk
  rhoBC: 0.55, tauBC: 3,
  splitAB: 0.60,                  // share of alighting passengers heading toward B
  splitBC: 0.75,                  // share of B's arrivals turning toward C
  bgB: 8, bgC: 5,                 // per-bin background pedestrians, unrelated to the station
};

function simulate(seed: number) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pois = (l: number) => {
    let k = 0, p = 1;
    const e = Math.exp(-l);
    do { k++; p *= rnd(); } while (p > e);
    return k - 1;
  };

  // A — train pulses every 15 bins
  const aToB = new Float64Array(N), aAlt = new Float64Array(N);
  for (let t = 0; t < N; t++) {
    const lambda = t % 15 === 0 ? 150 : t % 15 === 1 ? 70 : t % 15 === 2 ? 20 : 3;
    const alight = pois(lambda);
    const toB = Math.round(alight * TRUE.splitAB);
    aToB[t] = toB;
    aAlt[t] = alight - toB;
  }

  // B — retained share of A's flow, lagged, plus unrelated background
  const bTotal = new Float64Array(N);
  for (let t = 0; t < N; t++) {
    const src = t - TRUE.tauAB >= 0 ? aToB[t - TRUE.tauAB] : 0;
    bTotal[t] = Math.round(src * TRUE.rhoAB) + pois(TRUE.bgB);
  }
  const bToC = new Float64Array(N), bToX = new Float64Array(N);
  for (let t = 0; t < N; t++) {
    bToC[t] = Math.round(bTotal[t] * TRUE.splitBC);
    bToX[t] = bTotal[t] - bToC[t];
  }

  // C
  const cTotal = new Float64Array(N);
  for (let t = 0; t < N; t++) {
    const src = t - TRUE.tauBC >= 0 ? bToC[t - TRUE.tauBC] : 0;
    cTotal[t] = Math.round(src * TRUE.rhoBC) + pois(TRUE.bgC);
  }

  const rows: RawBin[] = [];
  const push = (node: string, from: string | null, to: string, arr: Float64Array) => {
    for (let t = 0; t < N; t++)
      if (arr[t] > 0)
        rows.push({ nodeCode: node, fromApproach: from, toApproach: to,
                    binStartMs: T0 + t * BIN_MS, count: arr[t] });
  };
  push("A", null, "toB", aToB);
  push("A", null, "alt", aAlt);
  push("B", "fromA", "toC", bToC);
  push("B", "fromA", "toX", bToX);
  push("C", "fromB", "onward", cTotal);

  // ground truth for the path quantities
  const qAB = aToB.reduce((a, b) => a + b, 0);
  const truth = {
    qAB,
    abc: qAB * TRUE.rhoAB * TRUE.splitBC * TRUE.rhoBC,
    notB: qAB * (1 - TRUE.rhoAB),
    abNotC: qAB * TRUE.rhoAB * (1 - TRUE.splitBC * TRUE.rhoBC),
  };
  return { rows, truth };
}

function run(seed: number): { res: ReconcileResult; truth: ReturnType<typeof simulate>["truth"] } {
  const { rows, truth } = simulate(seed);
  const res = reconcile(
    toSeries(rows, BIN_MS),
    [
      { from: "A", to: "B", departureApproach: "toB", lengthM: 160 },  // ≈2 bins @1.35 m/s
      { from: "B", to: "C", departureApproach: "toC", lengthM: 240 },  // ≈3 bins
    ],
    [["A", "B", "C"]],
    { bootstrapSamples: 300, seed },
  );
  return { res, truth };
}

// ── single detailed replication ──────────────────────────────────────────
const { res, truth } = run(7);

console.log("── link fits (seed 7) ──");
for (const l of res.links) {
  console.log(
    `${l.from}→${l.to}  rho=${l.rho.toFixed(3)} [${l.rhoLow.toFixed(3)}, ${l.rhoHigh.toFixed(3)}]` +
    `  tau=${l.tauBins} bins (${l.tauSeconds}s)  corr=${l.correlation.toFixed(3)}` +
    `  speed=${l.effectiveSpeedMps?.toFixed(2)} m/s  turnShare=${l.turnShare.toFixed(3)}` +
    `  bg=${l.background.toFixed(1)}/bin  ${l.confidence}`,
  );
  for (const w of l.warnings) console.log(`      ! ${w}`);
}
console.log(`truth:  A→B rho=${TRUE.rhoAB} tau=${TRUE.tauAB} split=${TRUE.splitAB}` +
            `   B→C rho=${TRUE.rhoBC} tau=${TRUE.tauBC} split=${TRUE.splitBC}`);

console.log("\n── path estimates vs truth ──");
const truthFor: Record<string, number> = {
  "A→B→C": truth.abc,
  "A→¬B": truth.notB,
  "A→B→¬C": truth.abNotC,
};
for (const p of res.paths) {
  const t = truthFor[p.label];
  console.log(
    `${p.label.padEnd(9)} est=${p.estimate.toFixed(0).padStart(5)}` +
    ` [${p.ciLow.toFixed(0)}, ${p.ciHigh.toFixed(0)}]` +
    `  true=${t.toFixed(0).padStart(5)}` +
    `  err=${(((p.estimate - t) / t) * 100).toFixed(1)}%` +
    `  ${p.ciLow <= t && t <= p.ciHigh ? "covered" : "MISSED"}`,
  );
}

// ── Monte Carlo: bias and coverage ───────────────────────────────────────
const REPS = 60;
const acc = {
  rhoAB: [] as number[], rhoBC: [] as number[],
  tauOk: 0, covAB: 0, covBC: 0, covPath: 0, pathErr: [] as number[],
};

for (let i = 0; i < REPS; i++) {
  const { res: r, truth: t } = run(1000 + i * 13);
  const [ab, bc] = r.links;
  acc.rhoAB.push(ab.rho);
  acc.rhoBC.push(bc.rho);
  if (ab.tauBins === TRUE.tauAB && bc.tauBins === TRUE.tauBC) acc.tauOk++;
  if (ab.rhoLow <= TRUE.rhoAB && TRUE.rhoAB <= ab.rhoHigh) acc.covAB++;
  if (bc.rhoLow <= TRUE.rhoBC && TRUE.rhoBC <= bc.rhoHigh) acc.covBC++;
  const p = r.paths.find((x) => x.label === "A→B→C")!;
  if (p.ciLow <= t.abc && t.abc <= p.ciHigh) acc.covPath++;
  acc.pathErr.push((p.estimate - t.abc) / t.abc);
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

console.log(`\n── Monte Carlo, ${REPS} replications ──`);
console.log(`rho_AB   mean=${mean(acc.rhoAB).toFixed(4)}  sd=${sd(acc.rhoAB).toFixed(4)}` +
            `  bias=${((mean(acc.rhoAB) - TRUE.rhoAB) / TRUE.rhoAB * 100).toFixed(2)}%` +
            `  95% CI coverage=${((acc.covAB / REPS) * 100).toFixed(0)}%`);
console.log(`rho_BC   mean=${mean(acc.rhoBC).toFixed(4)}  sd=${sd(acc.rhoBC).toFixed(4)}` +
            `  bias=${((mean(acc.rhoBC) - TRUE.rhoBC) / TRUE.rhoBC * 100).toFixed(2)}%` +
            `  95% CI coverage=${((acc.covBC / REPS) * 100).toFixed(0)}%`);
console.log(`tau      exact recovery on both legs=${((acc.tauOk / REPS) * 100).toFixed(0)}%`);
console.log(`A→B→C    mean error=${(mean(acc.pathErr) * 100).toFixed(2)}%` +
            `  sd=${(sd(acc.pathErr) * 100).toFixed(2)}%` +
            `  coverage=${((acc.covPath / REPS) * 100).toFixed(0)}%`);
