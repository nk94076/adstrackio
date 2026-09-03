"use client";

import type { ReportTimeseriesPoint } from "@/lib/types";

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
 * Phase 10: the reporting layer's own trend chart, alongside (not
 * replacing) ClickTrendChart — this one plots clicks and conversions on
 * two independently-scaled axes (a conversion count is typically a small
 * fraction of a click count, so sharing one scale would flatten the
 * conversions line to nearly zero). Same minimal-inline-SVG, no-chart-
 * library approach as ClickTrendChart.
 */
export function ReportTrendChart({ points }: { points: ReportTimeseriesPoint[] }) {
  if (points.length === 0) {
    return <p className="py-12 text-center text-sm text-slate-500">No data in this range.</p>;
  }

  const maxClicks = Math.max(1, ...points.map((p) => p.clicks));
  const maxConversions = Math.max(1, ...points.map((p) => p.conversions));
  const clicksPath = buildPath(
    points.map((p) => p.clicks),
    maxClicks,
  );
  const conversionsPath = buildPath(
    points.map((p) => p.conversions),
    maxConversions,
  );

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-48 w-full"
        role="img"
        aria-label="Clicks and conversions over time"
      >
        <line
          x1={PADDING}
          y1={HEIGHT - PADDING}
          x2={WIDTH - PADDING}
          y2={HEIGHT - PADDING}
          stroke="#e2e8f0"
        />
        <path d={clicksPath} fill="none" stroke="#4f46e5" strokeWidth={2} />
        <path d={conversionsPath} fill="none" stroke="#059669" strokeWidth={1.5} strokeDasharray="4 3" />
      </svg>
      <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-brand-600" /> Clicks
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-600" /> Conversions (own scale)
        </span>
        <span className="ml-auto font-mono">
          {points[0]?.bucket.slice(0, 10)} – {points[points.length - 1]?.bucket.slice(0, 10)}
        </span>
      </div>
    </div>
  );
}
