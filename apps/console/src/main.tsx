import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/layout";
import { Loading } from "./components/ui";
import { SessionProvider, useSession } from "./lib/session";
import { ToastProvider } from "./lib/toast";
import { DirectoryPage } from "./pages/directory";
import { DisbursementsPage } from "./pages/disbursements";
import { LedgerPage } from "./pages/ledger";
import { OverviewPage } from "./pages/overview";
import { PaymentsPage } from "./pages/payments";
import { RemittancesPage } from "./pages/remittances";
import { ReportsPage } from "./pages/reports";
import { ReservesPage } from "./pages/reserves";
import { SignInPage } from "./pages/sign-in";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
});

function App() {
  const { operator, ready } = useSession();
  if (!ready) return <Loading />;
  if (!operator) return <SignInPage />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/remittances" element={<RemittancesPage />} />
        <Route path="/disbursements" element={<DisbursementsPage />} />
        <Route path="/reserves" element={<ReservesPage />} />
        <Route path="/directory" element={<DirectoryPage />} />
        <Route path="/ledger" element={<LedgerPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The page has no root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
