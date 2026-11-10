import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

import { formatDateTime } from "../lib/format";
import { useApi } from "../lib/hooks";
import { ROLE_LABELS, useOperator, useSession } from "../lib/session";
import type { Overview } from "../lib/types";
import { Button } from "./ui";

interface NavItem {
  to: string;
  label: string;
  /** Items waiting for a decision, shown beside the label. */
  pending?: (overview: Overview) => number;
}

const NAVIGATION: NavItem[] = [
  { to: "/", label: "Overview" },
  { to: "/payments", label: "Payments" },
  { to: "/remittances", label: "Remittances", pending: (overview) => overview.pending.remittances },
  { to: "/disbursements", label: "Disbursements", pending: (overview) => overview.pending.batches },
  {
    to: "/reserves",
    label: "Reserves",
    pending: (overview) => overview.pending.issuance + overview.pending.redemptions,
  },
  { to: "/directory", label: "Directory" },
  { to: "/ledger", label: "Ledger" },
  { to: "/reports", label: "Reports" },
];

export function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/takarail.svg" alt="" className="h-8 w-8" />
      <div className="leading-tight">
        <div className={`text-base font-semibold tracking-tight ${inverse ? "text-white" : "text-ink"}`}>TakaRail</div>
        <div className={`text-[11px] ${inverse ? "text-white/70" : "text-ink-3"}`}>Settlement network</div>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const operator = useOperator();
  const { signOut } = useSession();
  const overview = useApi<Overview>("/v1/overview", { refetchMs: 15_000 });
  const headline = overview.data?.headline;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-surface">
        <div className="px-5 py-5">
          <Brand />
        </div>
        <nav className="flex-1 space-y-0.5 px-3" aria-label="Sections">
          {NAVIGATION.map((item) => {
            const pending = overview.data && item.pending ? item.pending(overview.data) : 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium ${
                    isActive ? "bg-brand-wash text-brand-strong" : "text-ink-2 hover:bg-sunken hover:text-ink"
                  }`
                }
              >
                {item.label}
                {pending > 0 && (
                  <span
                    className="rounded-full bg-warning px-1.5 text-[11px] leading-5 font-semibold text-ink"
                    title={`${pending} waiting for a decision`}
                  >
                    {pending}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
        <div className="border-t border-line px-5 py-4 text-xs text-ink-3">
          <div className="flex items-center gap-1.5 text-ink-2">
            <span aria-hidden className="h-2 w-2 rounded-full bg-good" />
            Block {headline?.indexedBlock ?? "-"}
          </div>
          <div className="mt-1">Chain time {formatDateTime(headline?.indexedBlockTime)}</div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center justify-end gap-4 border-b border-line bg-page/90 px-8 py-3 backdrop-blur">
          <div className="text-right leading-tight">
            <div className="text-sm font-medium">{operator.displayName}</div>
            <div className="text-xs text-ink-3">
              {ROLE_LABELS[operator.role]}
              {operator.institutionId ? ` · ${operator.institutionId}` : ""}
            </div>
          </div>
          <Button small onClick={signOut}>
            Sign out
          </Button>
        </header>
        <main className="mx-auto max-w-[1280px] px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
