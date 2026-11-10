/** Building blocks of the console. Presentation only; no data fetching. */
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
} from "react";

import { formatTaka, shortAddress, shortHash } from "../lib/format";
import { ROLE_LABELS, hasRole, useOperator } from "../lib/session";
import type { OperatorRole } from "../lib/types";

// ------------------------------------------------------------------ layout

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  flush = false,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Lets a table run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-2">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? "" : "px-5 pb-5"}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-4">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-ink-3">{children}</p>;
}

export function Loading() {
  return <p className="px-5 py-8 text-center text-sm text-ink-3">Loading&hellip;</p>;
}

// ------------------------------------------------------------------ controls

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-strong",
  secondary: "border border-line bg-surface text-ink hover:bg-sunken",
  danger: "border border-critical/40 bg-surface text-critical hover:bg-critical/5",
  ghost: "text-ink-2 hover:bg-sunken",
};

export function Button({
  variant = "secondary",
  small = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        small ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm"
      } ${BUTTON_STYLES[variant]} ${className}`}
    />
  );
}

const CONTROL =
  "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={`${CONTROL} ${props.className ?? ""}`} />
);

export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={`${CONTROL} ${props.className ?? ""}`} />
);

export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={`${CONTROL} font-mono text-xs ${props.className ?? ""}`} />
);

/** Two-option switch, for instance between a chart and its table. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${
            option.value === value ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ dialog

export function Dialog({
  title,
  description,
  open,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 pt-[8vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        className={`w-full rounded-xl border border-line bg-surface shadow-xl ${wide ? "max-w-3xl" : "max-w-lg"}`}
      >
        <div className="border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ status

type Tone = "good" | "warning" | "critical" | "neutral";

const STATUS_TONES: Record<string, Tone> = {
  Active: "good",
  Paid: "good",
  Completed: "good",
  Settled: "good",
  Approved: "good",
  Accepted: "good",
  Balanced: "good",
  Pending: "warning",
  UnderReview: "warning",
  AwaitingApproval: "warning",
  Frozen: "critical",
  Rejected: "critical",
  Failed: "critical",
  Mismatch: "critical",
  Reclaimed: "neutral",
  Closed: "neutral",
  Suspended: "critical",
};

const STATUS_LABELS: Record<string, string> = {
  UnderReview: "Under review",
  AwaitingApproval: "Awaiting approval",
};

const TONE_MARK: Record<Tone, { glyph: string; className: string }> = {
  good: { glyph: "✓", className: "bg-good text-white" },
  warning: { glyph: "•", className: "bg-warning text-ink" },
  critical: { glyph: "×", className: "bg-critical text-white" },
  neutral: { glyph: "–", className: "bg-axis text-ink" },
};

/** Status with a mark and a label, so the state never rests on colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const mark = TONE_MARK[STATUS_TONES[status] ?? "neutral"];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap text-ink">
      <span
        aria-hidden
        className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none font-bold ${mark.className}`}
      >
        {mark.glyph}
      </span>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-sunken px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-ink-2">
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ data

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  /** Extra classes of the cell, for instance a width. */
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty = "Nothing to show yet.",
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string | number;
  empty?: string;
  onRowClick?: (row: T) => void;
}) {
  if (!rows) return <Loading />;
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-y border-line bg-sunken/60 text-xs text-ink-2">
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={`px-3 py-2 font-medium whitespace-nowrap first:pl-5 last:pr-5 ${column.align === "right" ? "text-right" : "text-left"}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-line last:border-0 ${onRowClick ? "cursor-pointer hover:bg-sunken/50" : ""}`}
            >
              {columns.map((column) => (
                <td
                  key={column.header}
                  className={`px-3 py-2.5 align-middle first:pl-5 last:pr-5 ${column.align === "right" ? "figures text-right" : ""} ${column.className ?? ""}`}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Taka amount from poisha. */
export function Money({ value, muted = false }: { value: string | bigint | null | undefined; muted?: boolean }) {
  if (value === null || value === undefined) return <span className="text-ink-3">-</span>;
  return <span className={`figures whitespace-nowrap ${muted ? "text-ink-2" : ""}`}>{formatTaka(value)}</span>;
}

/** Party of a transaction: its label when known, its address underneath. */
export function Party({
  label,
  address,
  note,
}: {
  label: string | null | undefined;
  address: string;
  note?: string | null;
}) {
  return (
    <span className="block min-w-0">
      <span className="block truncate font-medium">{label ?? shortAddress(address)}</span>
      <span className="block truncate text-xs text-ink-3">
        {note ? `${note} · ` : ""}
        <span className="font-mono" title={address}>
          {shortAddress(address)}
        </span>
      </span>
    </span>
  );
}

/** Transaction hash, shortened. The full hash is in the title and copied on click. */
export function TxHash({ hash }: { hash: string | null | undefined }) {
  if (!hash) return <span className="text-ink-3">-</span>;
  return (
    <button
      type="button"
      title={`${hash}\nClick to copy`}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(hash);
      }}
      className="font-mono text-xs whitespace-nowrap text-ink-2 hover:text-brand"
    >
      {shortHash(hash)}
    </button>
  );
}

/** Label and value pairs of a detail panel. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-2">{label}</dt>
          <dd className="min-w-0 text-right break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------ roles

/**
 * Shows its children to operators who hold one of `roles`. Everyone else sees which role acts here,
 * which keeps the segregation of duties visible in the interface.
 */
export function RoleGate({ roles, children }: { roles: readonly OperatorRole[]; children: ReactNode }) {
  const operator = useOperator();
  if (hasRole(operator, roles)) return <>{children}</>;
  return (
    <span className="text-xs text-ink-3">
      Action of the {roles.map((role) => ROLE_LABELS[role].toLowerCase()).join(" or ")}
    </span>
  );
}
