"use client";

import type { ClickTimeseriesPoint } from "@/lib/types";

const WIDTH = 640;
const HEIGHT = 200;
const PADDING = 24;

function buildPath(values: number[], max: number): string {
  if (values.length === 0) return "";
  const stepX = values.length > 1 ? (WIDTH - PADDING * 2) / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = PADDING + index * stepX;
      const y =
        max > 0 ? HEIGHT - PADDING - (value / max) * (HEIGHT - PADDING * 2) : HEIGHT - PADDING;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * Minimal inline SVG line chart — the dashboard has no chart library
 * dependency (Phase 1-3 shipped with zero UI deps beyond Next/React/
 * Tailwind), and a trend line for two series doesn't warrant adding one.
 */
export function ClickTrendChart({ points }: { points: ClickTimeseriesPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-slate-500">No click data in this range.</p>
    );
  }

  const max = Math.max(1, ...points.map((p) => p.clicks));
  const clicksPath = buildPath(
    points.map((p) => p.clicks),
    max,
  );
  const botPath = buildPath(
    points.map((p) => p.botClicks),
    max,
  );

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-48 w-full" role="img" aria-label="Clicks over time">
        <line
          x1={PADDING}
          y1={HEIGHT - PADDING}
          x2={WIDTH - PADDING}
          y2={HEIGHT - PADDING}
          stroke="#e2e8f0"
        />
        <path d={clicksPath} fill="none" stroke="#4f46e5" strokeWidth={2} />
        <path d={botPath} fill="none" stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4 3" />
      </svg>
      <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-brand-600" /> Total clicks
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-600" /> Bot clicks
        </span>
        <span className="ml-auto font-mono">
          {points[0]?.bucket.slice(0, 10)} – {points[points.length - 1]?.bucket.slice(0, 10)}
        </span>
      </div>
    </div>
  );
}
