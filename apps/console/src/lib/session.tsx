import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { api, onSessionExpired, session } from "./api";
import type { Operator, OperatorRole } from "./types";

interface SessionState {
  /** Null while signed out. */
  operator: Operator | null;
  /** False until a stored session has been checked. */
  ready: boolean;
  signIn(username: string, passphrase: string): Promise<void>;
  signOut(): void;
}

const SessionContext = createContext<SessionState | null>(null);

export const ROLE_LABELS: Record<OperatorRole, string> = {
  network_operator: "Network operator",
  supervisor: "Supervisor",
  issuance_maker: "Issuance maker",
  reserve_checker: "Reserve checker",
  reserve_auditor: "Reserve auditor",
  compliance_officer: "Compliance officer",
  institution_admin: "Institution administrator",
  exchange_house: "Exchange house",
  treasury: "Treasury",
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [operator, setOperator] = useState<Operator | null>(null);
  const [ready, setReady] = useState(false);

  const signOut = useCallback(() => {
    session.token = null;
    setOperator(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    onSessionExpired(() => {
      setOperator(null);
      queryClient.clear();
    });
    if (!session.token) {
      setReady(true);
      return;
    }
    api
      .get<Operator>("/v1/auth/session")
      .then(setOperator)
      .catch(() => {
        session.token = null;
      })
      .finally(() => setReady(true));
  }, [queryClient]);

  const signIn = useCallback(
    async (username: string, passphrase: string) => {
      const result = await api.post<{ token: string; operator: Operator }>("/v1/auth/sign-in", {
        username,
        passphrase,
      });
      session.token = result.token;
      queryClient.clear();
      setOperator(result.operator);
    },
    [queryClient],
  );

  const value = useMemo(() => ({ operator, ready, signIn, signOut }), [operator, ready, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const state = useContext(SessionContext);
  if (!state) throw new Error("useSession must be used inside SessionProvider");
  return state;
}

/** The signed-in operator. Only call inside the authenticated part of the app. */
export function useOperator(): Operator {
  const { operator } = useSession();
  if (!operator) throw new Error("No operator is signed in");
  return operator;
}

/** True when the operator holds one of `roles`. */
export const hasRole = (operator: Operator, roles: readonly OperatorRole[]) => roles.includes(operator.role);
