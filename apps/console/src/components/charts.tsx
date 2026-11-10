/**
 * Charts of the console. Each one has a table twin behind the "Table" switch, a hover layer, thin
 * marks on a recessive grid, and text in ink colours: identity is carried by the mark beside it.
 */
import { type ReactNode, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { compactTaka, formatTaka } from "../lib/format";
import { Card, Segmented } from "./ui";

const AXIS_TICK = { fontSize: 11, fill: "var(--color-ink-3)" };
const VIEWS = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
] as const;

/** Taka on an axis: whole numbers below one lakh, then lakh and crore. */
export function axisTaka(value: number): string {
  if (value >= 10_000_000) return `${+(value / 10_000_000).toFixed(1)} cr`;
  if (value >= 100_000) return `${+(value / 100_000).toFixed(1)} L`;
  if (value >= 1_000) return `${+(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Card that shows a chart or the same figures as a table. */
export function ChartCard({
  title,
  subtitle,
  children,
  table,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  table: ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<(typeof VIEWS)[number]["value"]>("chart");
  return (
    <Card
      title={title}
      subtitle={subtitle}
      className={className}
      flush={view === "table"}
      actions={<Segmented label={`${title} view`} value={view} options={VIEWS} onChange={setView} />}
    >
      {view === "chart" ? children : table}
    </Card>
  );
}

interface TooltipRow {
  name: string;
  value: string;
  color?: string;
}

function TooltipBox({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-semibold">{title}</div>
      {rows.map((row) => (
        <div key={row.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-ink-2">
            {row.color && <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: row.color }} />}
            {row.name}
          </span>
          <span className="figures font-medium">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export interface ColumnPoint {
  label: string;
  /** Taka, as a number for the scale. */
  value: number;
  /** Poisha, for exact display. */
  amount: string;
  count: number;
}

/** One series as thin columns, with the most recent value labelled on its cap. */
export function ColumnChart({ title, unit, points }: { title: string; unit: string; points: ColumnPoint[] }) {
  const last = points.length - 1;
  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-xs font-medium text-ink-2">{title}</figcaption>
      <ResponsiveContainer width="100%" height={170}>
        <BarChart data={points} margin={{ top: 18, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-line)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: "var(--color-axis)" }}
            tick={AXIS_TICK}
            interval={0}
          />
          <YAxis width={44} tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={axisTaka} tickCount={4} />
          <Tooltip
            cursor={{ fill: "var(--color-sunken)" }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const point = active ? (payload?.[0]?.payload as ColumnPoint | undefined) : undefined;
              if (!point) return null;
              return (
                <TooltipBox
                  title={point.label}
                  rows={[
                    { name: "Value", value: formatTaka(point.amount) },
                    { name: unit, value: String(point.count) },
                  ]}
                />
              );
            }}
          />
          <Bar
            dataKey="value"
            fill="var(--color-series-1)"
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
            isAnimationActive={false}
            label={({
              x,
              y,
              width,
              index,
            }: {
              x?: number | string;
              y?: number | string;
              width?: number | string;
              index?: number;
            }) => {
              const point = index === last ? points[last] : undefined;
              if (!point || point.value === 0) return <g />;
              return (
                <text
                  x={Number(x) + Number(width) / 2}
                  y={Number(y) - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--color-ink)"
                >
                  {axisTaka(point.value)}
                </text>
              );
            }}
          />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

export interface CoveragePoint {
  label: string;
  supply: number;
  reserve: number | null;
}

const COVERAGE_SERIES = [
  { key: "reserve", name: "Reserve statement", color: "var(--color-series-2)" },
  { key: "supply", name: "tBDT in circulation", color: "var(--color-series-1)" },
] as const;

/** Supply against the reserve statement in force, as two step lines on one axis. */
export function CoverageChart({ points }: { points: CoveragePoint[] }) {
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-4 text-xs text-ink-2">
        {COVERAGE_SERIES.map((series) => (
          <li key={series.key} className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: series.color }} />
            {series.name}
          </li>
        ))}
      </ul>
      <ResponsiveContainer width="100%" height={230}>
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-line)" />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--color-axis)" }} tick={AXIS_TICK} />
          <YAxis
            width={52}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            tickFormatter={axisTaka}
            tickCount={5}
            domain={[
              (min: number) => Math.floor((min * 0.97) / 1e7) * 1e7,
              (max: number) => Math.ceil((max * 1.02) / 1e7) * 1e7,
            ]}
          />
          <Tooltip
            cursor={{ stroke: "var(--color-axis)" }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const point = active ? (payload?.[0]?.payload as CoveragePoint | undefined) : undefined;
              if (!point) return null;
              return (
                <TooltipBox
                  title={point.label}
                  rows={COVERAGE_SERIES.map((series) => ({
                    name: series.name,
                    color: series.color,
                    value:
                      point[series.key] === null
                        ? "-"
                        : compactTaka(BigInt(Math.round((point[series.key] ?? 0) * 100))),
                  }))}
                />
              );
            }}
          />
          {COVERAGE_SERIES.map((series) => (
            <Line
              key={series.key}
              type="stepAfter"
              dataKey={series.key}
              stroke={series.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface RankedRow {
  key: string;
  label: string;
  note?: string;
  /** Poisha. */
  amount: string;
}

/** One series ranked as thin horizontal bars, each with its value at the tip. */
export function RankedBars({ rows }: { rows: RankedRow[] }) {
  const max = rows.reduce((highest, row) => (BigInt(row.amount) > highest ? BigInt(row.amount) : highest), 0n);
  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const share = max === 0n ? 0 : Number((BigInt(row.amount) * 1000n) / max) / 10;
        return (
          <li key={row.key} title={`${row.label}: ${formatTaka(row.amount)}`}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate font-medium">
                {row.label}
                {row.note && <span className="ml-2 text-xs font-normal text-ink-3">{row.note}</span>}
              </span>
              <span className="figures shrink-0">{compactTaka(row.amount)}</span>
            </div>
            <div className="mt-1 h-2 bg-sunken" style={{ borderRadius: "0 4px 4px 0" }}>
              <div
                className="h-2 bg-series-1"
                style={{ width: `${Math.max(share, 0.5)}%`, borderRadius: "0 4px 4px 0" }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Net position around a neutral centre line: inflow to the right, outflow to the left. */
export function NetBar({ value, max }: { value: bigint; max: bigint }) {
  const share = max === 0n ? 0 : Number(((value < 0n ? -value : value) * 1000n) / max) / 10 / 2;
  const positive = value >= 0n;
  return (
    <div className="relative h-2 w-40 bg-sunken" aria-hidden>
      <div className="absolute inset-y-0 left-1/2 w-px bg-axis" />
      {value !== 0n && (
        <div
          className="absolute inset-y-0"
          style={{
            width: `${Math.max(share, 1)}%`,
            background: positive ? "var(--color-series-1)" : "#e34948",
            borderRadius: positive ? "0 4px 4px 0" : "4px 0 0 4px",
            ...(positive ? { left: "50%" } : { right: "50%" }),
          }}
        />
      )}
    </div>
  );
}
