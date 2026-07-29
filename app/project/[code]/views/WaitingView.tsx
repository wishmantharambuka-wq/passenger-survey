"use client";

export default function WaitingView({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center p-6">
      <div className="glass rounded-3xl p-8 text-center">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-white/15 border-t-orange" />
        <p className="mt-4 text-lg font-semibold text-white">{title}</p>
        {subtitle && <p className="mt-1 max-w-xs text-sm text-ash">{subtitle}</p>}
      </div>
    </main>
  );
}
