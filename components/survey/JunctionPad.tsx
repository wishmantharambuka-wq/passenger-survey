"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { deviceId, enqueue, flush, pendingCount, startAutoFlush } from "@/lib/offline/queue";
import { getClockOffsetMs, needsResync, stampNow, syncClock } from "@/lib/realtime/clock";

/**
 * The field UI. A stylised junction diagram: central hub with the participant's
 * code + running total, and one big tap arm per exit direction.
 *
 * Arms come from the edges the admin drew — each edge becomes an arm labelled
 * with the connected participant's code (B, C, …) and rotated to the real
 * compass bearing. A junction with three drawn edges renders three arms; a
 * cross-junction with four renders four. If the admin hasn't drawn any edges
 * for this participant yet, we fall back to their picked junction_kind (e.g. a
 * bare 4-way with N/E/S/W arms so tapping still works).
 */

export interface JunctionArm {
  id: string;            // stable id — edge id when connected, compass tag otherwise
  bearing: number;       // degrees from north
  label: string;         // 'B' when connected, 'N' otherwise
  connected: boolean;
}

export interface JunctionPadProps {
  projectId: string;
  userId: string;
  code: string;                     // A / B / C — this participant's letter
  kind: "straight" | "t_junction" | "cross_junction" | "terminus" | "custom";
  arms: JunctionArm[];              // clean compass arms from fallbackArms(kind)
  /** Origin nodes (terminus, e.g. station exit) don't need a "coming from" step. */
  isOrigin?: boolean;
  /** Render a Done button in the footer. Wired by the parent (admin closes
   *  the whole project; participants show a "waiting" screen). */
  onDone?: () => void;
  doneLabel?: string;
  doneVariant?: "primary" | "muted";
}

interface LocalTap { id: string; armId: string; at: number }

export default function JunctionPad({
  projectId, userId, code, kind, arms, isOrigin,
  onDone, doneLabel = "Done", doneVariant = "primary",
}: JunctionPadProps) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<LocalTap[]>([]);
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(true);
  const [inbound, setInbound] = useState<string | null>(null);
  const [rate, setRate] = useState(0);

  const channel = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const tapTimes = useRef<number[]>([]);

  const treatAsOrigin = isOrigin || kind === "terminus" || arms.length <= 1;
  const totalArms = arms.length || fallbackArms(kind).length;
  const displayArms: JunctionArm[] = arms.length ? arms : fallbackArms(kind);

  // ── wiring ─────────────────────────────────────────────────────────────
  useEffect(() => {
    void syncClock();
    const stopFlush = startAutoFlush(4000);

    channel.current = supabase.channel(`project:${projectId}:pulse`, {
      config: { presence: { key: userId } },
    });
    channel.current.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.current?.track({ userId, code, at: Date.now() });
      }
    });

    const onNet = () => setOnline(navigator.onLine);
    onNet();
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);

    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});

    const tick = setInterval(async () => {
      setQueued(await pendingCount());
      if (needsResync()) void syncClock();
      const cutoff = Date.now() - 60_000;
      tapTimes.current = tapTimes.current.filter((t) => t > cutoff);
      setRate(tapTimes.current.length);
    }, 2000);

    return () => {
      stopFlush(); clearInterval(tick);
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
      void lock?.release();
      void channel.current?.unsubscribe();
    };
  }, [projectId, userId, code]);

  // ── the tap ────────────────────────────────────────────────────────────
  const tap = useCallback(
    async (arm: JunctionArm) => {
      const id = crypto.randomUUID();
      const stamp = stampNow();

      // optimistic — a surveyor taps ~40x/min, this must feel instant
      setCounts((c) => ({ ...c, [arm.id]: (c[arm.id] ?? 0) + 1 }));
      setRecent((r) => [{ id, armId: arm.id, at: Date.now() }, ...r].slice(0, 12));
      tapTimes.current.push(Date.now());
      navigator.vibrate?.(12);

      await enqueue({
        id,
        project_id: projectId,
        user_id: userId,
        from_arm: treatAsOrigin ? null : inbound,
        to_arm: arm.id,
        delta: 1,
        attributes: {},
        occurred_at_device: stamp.occurred_at_device,
        clock_offset_ms: stamp.clock_offset_ms,
        device_id: deviceId(),
      });

      void channel.current?.send({
        type: "broadcast", event: "tap",
        payload: { userId, code, armId: arm.id, at: Date.now() + getClockOffsetMs() },
      });
      void flush();
    },
    [projectId, userId, code, treatAsOrigin, inbound],
  );

  const undo = useCallback(async () => {
    const last = recent[0];
    if (!last) return;
    setRecent((r) => r.slice(1));
    setCounts((c) => ({ ...c, [last.armId]: Math.max(0, (c[last.armId] ?? 1) - 1) }));
    navigator.vibrate?.([8, 40, 8]);

    const stamp = stampNow();
    await enqueue({
      id: crypto.randomUUID(),
      project_id: projectId,
      user_id: userId,
      from_arm: treatAsOrigin ? null : inbound,
      to_arm: last.armId,
      delta: -1,
      attributes: { undo_of: last.id },
      occurred_at_device: stamp.occurred_at_device,
      clock_offset_ms: stamp.clock_offset_ms,
      device_id: deviceId(),
    });
    void flush();
  }, [recent, projectId, userId, treatAsOrigin, inbound]);

  const total = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);

  // ── layout: SVG junction with radial arms ──────────────────────────────
  const SIZE = 340;
  const CENTER = SIZE / 2;
  const HUB_R = 68;
  const ARM_LEN = 132;

  // the +20px keeps the fixed credit line clear of the Done button
  return (
    <div className="flex h-full flex-col gap-3 p-3 pb-[calc(env(safe-area-inset-bottom)+20px)]">
      {/* status strip */}
      <div className="glass flex items-center gap-3 rounded-2xl px-4 py-2.5">
        <span className="text-2xl font-bold text-white">Node {code}</span>
        <span className="truncate text-xs uppercase tracking-wider text-ash">
          {kindLabel(kind)} · {totalArms} arm{totalArms === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="tabular-nums text-white/80">{rate}/min</span>
          <span
            className={`h-2 w-2 rounded-full ${
              !online ? "bg-orange" : queued > 0 ? "animate-pulse bg-blue" : "bg-green"
            }`}
            title={!online ? "offline — queued" : queued > 0 ? `syncing ${queued}` : "synced"}
          />
        </div>
      </div>

      {/* midpoint: which arm are they arriving from */}
      {!treatAsOrigin && displayArms.length > 2 && (
        <div className="glass rounded-2xl p-2">
          <div className="px-2 pb-1.5 text-[10px] uppercase tracking-wider text-ash">
            Arriving from
          </div>
          <div className="flex gap-1.5 overflow-x-auto">
            {displayArms.map((a) => (
              <button
                key={`in-${a.id}`}
                onClick={() => setInbound(a.id)}
                className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                  inbound === a.id ? "bg-orange text-black" : "bg-white/5 text-ash active:bg-white/10"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* the junction */}
      <div className="glass grid flex-1 place-items-center rounded-3xl">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          width="100%" height="100%"
          style={{ maxWidth: 420, maxHeight: 420, touchAction: "manipulation" }}
        >
          {/* soft direction guides */}
          {displayArms.map((a) => {
            const { x2, y2 } = tip(CENTER, a.bearing, ARM_LEN);
            return (
              <line
                key={`guide-${a.id}`}
                x1={CENTER} y1={CENTER} x2={x2} y2={y2}
                stroke="rgba(30,144,255,0.35)" strokeWidth={14}
                strokeLinecap="round"
              />
            );
          })}

          {/* tap targets */}
          {displayArms.map((a) => {
            const disabled = !treatAsOrigin && a.id === inbound;
            const { x2, y2 } = tip(CENTER, a.bearing, ARM_LEN);
            const count = counts[a.id] ?? 0;
            return (
              <g key={a.id} opacity={disabled ? 0.35 : 1}
                 onPointerDown={disabled ? undefined : () => void tap(a)}
                 style={{ cursor: disabled ? "not-allowed" : "pointer" }}>
                <circle cx={x2} cy={y2} r={54}
                        fill="rgba(255,255,255,0.10)"
                        stroke={armColor(a)}
                        strokeWidth={2}
                        style={{
                          filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.35))",
                        }} />
                <ArrowHead cx={x2} cy={y2} bearing={a.bearing} color={armColor(a)} />
                <text x={x2} y={y2 + 6} textAnchor="middle"
                      fontSize="26" fontWeight="700" fill="#fff"
                      style={{ fontVariantNumeric: "tabular-nums" }}>
                  {count}
                </text>
                <text x={x2} y={y2 + 28} textAnchor="middle"
                      fontSize="11" fill="rgba(255,255,255,0.75)"
                      letterSpacing="0.06em">
                  {a.label.toUpperCase()}
                </text>
              </g>
            );
          })}

          {/* hub: participant code + running total */}
          <circle cx={CENTER} cy={CENTER} r={HUB_R}
                  fill="rgba(11,13,14,0.85)" stroke="rgba(255,255,255,0.25)" strokeWidth={2} />
          <text x={CENTER} y={CENTER - 6} textAnchor="middle"
                fontSize="34" fontWeight="800" fill="#FF7A18">{code}</text>
          <text x={CENTER} y={CENTER + 22} textAnchor="middle"
                fontSize="14" fill="rgba(255,255,255,0.75)"
                style={{ fontVariantNumeric: "tabular-nums" }}>
            {total}
          </text>
        </svg>
      </div>

      {/* footer */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void undo()}
          disabled={recent.length === 0}
          className="glass rounded-2xl px-5 py-3.5 text-sm font-semibold text-orange disabled:opacity-30"
        >
          Undo
        </button>
        <div className="glass rounded-2xl px-4 py-3.5 text-sm">
          <span className="text-ash">total </span>
          <span className="font-bold tabular-nums text-white">{total}</span>
        </div>
        {onDone && (
          <button
            onClick={onDone}
            className={`ml-auto rounded-2xl px-6 py-3.5 text-base font-bold active:scale-[0.98] ${
              doneVariant === "primary"
                ? "bg-green text-black"
                : "glass text-white"
            }`}
          >
            {doneLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function tip(center: number, bearing: number, len: number) {
  // SVG: y grows downward; compass 0° = up. Rotate by bearing.
  const rad = ((bearing - 90) * Math.PI) / 180;
  return { x2: center + len * Math.cos(rad), y2: center + len * Math.sin(rad) };
}

function ArrowHead({ cx, cy, bearing, color }:
  { cx: number; cy: number; bearing: number; color: string }) {
  const rad = ((bearing - 90) * Math.PI) / 180;
  const back = 34, wing = 12;
  const bx = cx - back * Math.cos(rad), by = cy - back * Math.sin(rad);
  const p1x = bx + wing * Math.cos(rad + Math.PI / 2);
  const p1y = by + wing * Math.sin(rad + Math.PI / 2);
  const p2x = bx + wing * Math.cos(rad - Math.PI / 2);
  const p2y = by + wing * Math.sin(rad - Math.PI / 2);
  return (
    <polygon points={`${cx},${cy} ${p1x},${p1y} ${p2x},${p2y}`}
             fill={color} opacity={0.85} />
  );
}

function armColor(a: JunctionArm): string {
  return a.connected ? "#27AE60" : "#1E90FF";
}

function kindLabel(k: JunctionPadProps["kind"]): string {
  return { straight: "Straight road", t_junction: "3-way junction",
           cross_junction: "4-way junction", terminus: "Terminus / Origin",
           custom: "Custom node" }[k];
}

/**
 * Compass arms for each junction type. The id IS the compass tag ('N', 'NE',
 * 'E', …) so the raw taps and the CSV export are human-readable — no
 * `dir-90` internals leaking into the analyst's spreadsheet.
 *
 * The counting UI never uses letter labels for arms (B, C, …). The junction
 * kind picked in the lobby is the only thing that shapes this widget.
 */
export function fallbackArms(kind: JunctionPadProps["kind"]): JunctionArm[] {
  const arms = (bearings: number[]) =>
    bearings.map((b) => ({
      id: compass(b),
      bearing: b,
      label: compass(b),
      connected: false,
    }));
  switch (kind) {
    case "straight":       return arms([0, 180]);                       // N, S
    case "t_junction":     return arms([0, 120, 240]);                  // N, SE, SW
    case "cross_junction": return arms([0, 90, 180, 270]);              // N, E, S, W
    case "terminus":       return arms([0]);                            // out only
    default:               return arms([0, 45, 90, 135, 180, 225, 270, 315]);
  }
}

function compass(b: number): string {
  return ["N","NE","E","SE","S","SW","W","NW"][Math.round(b / 45) % 8];
}
