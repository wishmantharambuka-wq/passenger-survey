"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  at: number;
}

export type GeoStatus =
  | "idle"
  | "prompting"
  | "watching"
  | "denied"
  | "unavailable"
  | "insecure";

/**
 * Live GPS via the browser.
 *
 * Mobile-browser realities baked in:
 *  - geolocation requires HTTPS (or localhost). On plain http over a LAN it
 *    fails silently on iOS, so we detect and report `insecure` explicitly.
 *  - iOS Safari only grants the permission from a user gesture, so acquisition
 *    is triggered by calling `request()` from a tap — never automatically.
 *  - the first fix is often a 2km-accurate cell-tower guess; we ignore fixes
 *    worse than `minAccuracy` until a real one arrives.
 */
export function useGeolocation(opts: { minAccuracy?: number; enableHighAccuracy?: boolean } = {}) {
  const { minAccuracy = 100, enableHighAccuracy = true } = opts;

  const [fix, setFix] = useState<GeoFix | null>(null);
  const [status, setStatus] = useState<GeoStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const watchId = useRef<number | null>(null);

  const request = useCallback(() => {
    if (typeof window === "undefined") return;

    if (!window.isSecureContext) {
      setStatus("insecure");
      setError("Geolocation needs HTTPS. Use a tunnel (ngrok / Vercel preview) for field testing.");
      return;
    }
    if (!("geolocation" in navigator)) {
      setStatus("unavailable");
      return;
    }

    setStatus("prompting");
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next: GeoFix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          at: pos.timestamp,
        };
        // reject the coarse first fix unless we have nothing at all
        setFix((prev) => (next.accuracy <= minAccuracy || !prev ? next : prev));
        setStatus("watching");
        setError(null);
      },
      (err) => {
        setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable");
        setError(err.message);
      },
      { enableHighAccuracy, timeout: 15_000, maximumAge: 2_000 },
    );
  }, [enableHighAccuracy, minAccuracy]);

  const stop = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
      setStatus("idle");
    }
  }, []);

  useEffect(() => stop, [stop]);

  return { fix, status, error, request, stop };
}
