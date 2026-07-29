"use client";

import { supabase } from "@/lib/supabase/client";

/**
 * Write-ahead queue for count events.
 *
 * A surveyor standing under a railway bridge will lose signal. Every tap is
 * written to IndexedDB FIRST and flushed opportunistically. Because each event
 * carries a client-generated UUID primary key, replaying the queue is
 * idempotent — a duplicate insert is discarded by the database, so we can
 * retry as aggressively as we like without inflating anyone's counts.
 */

export interface CountEvent {
  id: string;
  session_id: string;
  node_id: string;
  surveyor_id: string;
  from_approach: string | null;
  to_approach: string;
  delta: 1 | -1;
  attributes: Record<string, unknown>;
  occurred_at_device: string;
  clock_offset_ms: number;
  device_id: string;
}

const DB_NAME = "pbs-queue";
const STORE = "events";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(evt: CountEvent): Promise<void> {
  await tx("readwrite", (s) => s.put(evt));
}

export async function pending(): Promise<CountEvent[]> {
  return tx("readonly", (s) => s.getAll() as IDBRequest<CountEvent[]>);
}

export async function pendingCount(): Promise<number> {
  return tx("readonly", (s) => s.count());
}

let flushing = false;

/** Push everything queued. Safe to call on a timer, on reconnect, on every tap. */
export async function flush(): Promise<{ sent: number; remaining: number }> {
  if (flushing || !navigator.onLine) {
    return { sent: 0, remaining: await pendingCount() };
  }
  flushing = true;
  try {
    const batch = (await pending()).slice(0, 200);
    if (batch.length === 0) return { sent: 0, remaining: 0 };

    const { error } = await supabase
      .from("count_events")
      .upsert(batch, { onConflict: "id", ignoreDuplicates: true });

    if (error) return { sent: 0, remaining: await pendingCount() };

    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      for (const e of batch) store.delete(e.id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });

    return { sent: batch.length, remaining: await pendingCount() };
  } finally {
    flushing = false;
  }
}

export function startAutoFlush(intervalMs = 5000): () => void {
  const timer = setInterval(() => void flush(), intervalMs);
  const onOnline = () => void flush();
  window.addEventListener("online", onOnline);
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", onOnline);
  };
}

/** Stable per-install id, so you can trace a suspicious series back to a phone. */
export function deviceId(): string {
  let id = localStorage.getItem("pbs-device-id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("pbs-device-id", id);
  }
  return id;
}
