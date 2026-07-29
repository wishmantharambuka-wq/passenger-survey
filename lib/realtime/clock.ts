"use client";

import { supabase } from "@/lib/supabase/client";

/**
 * Clock skew correction.
 *
 * Five surveyors carry five phones whose clocks disagree by seconds to minutes.
 * The flow algorithm correlates timestamps ACROSS those phones, so an
 * uncorrected 20s skew on a 90s walk silently corrupts every travel-time and
 * retention estimate — and the output still looks plausible, which is worse.
 *
 * NTP-style: measure round trip against the database, take the median of
 * several samples to reject the ones that hit a slow packet.
 */

let offsetMs = 0;
let lastSyncAt = 0;

const SAMPLES = 5;
const RESYNC_AFTER_MS = 10 * 60 * 1000;

export async function syncClock(): Promise<number> {
  const measurements: number[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    const t0 = Date.now();
    const { data, error } = await supabase.rpc("server_now");
    const t1 = Date.now();
    if (error || !data) continue;

    const server = new Date(data as string).getTime();
    // assume symmetric latency: server time at t0 was server - rtt/2
    const rtt = t1 - t0;
    measurements.push(server - (t0 + rtt / 2));
  }

  if (measurements.length === 0) return offsetMs;

  measurements.sort((a, b) => a - b);
  offsetMs = Math.round(measurements[Math.floor(measurements.length / 2)]);
  lastSyncAt = Date.now();
  return offsetMs;
}

export function getClockOffsetMs(): number {
  return offsetMs;
}

export function needsResync(): boolean {
  return Date.now() - lastSyncAt > RESYNC_AFTER_MS;
}

/** Device wall-clock at the moment of the tap. Pair it with the offset. */
export function stampNow() {
  return {
    occurred_at_device: new Date().toISOString(),
    clock_offset_ms: offsetMs,
  };
}
