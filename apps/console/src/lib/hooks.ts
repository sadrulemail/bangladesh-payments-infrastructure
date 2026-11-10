import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type CommandResult, api, describeError } from "./api";
import { shortHash } from "./format";
import { useToast } from "./toast";

/** Reads a resource of the API. The path is the cache key. */
export function useApi<T>(path: string, options: { enabled?: boolean; refetchMs?: number } = {}) {
  return useQuery({
    queryKey: [path],
    queryFn: () => api.get<T>(path),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchMs,
  });
}

interface Command {
  path: string;
  body?: unknown;
  /** What happened, shown once the network has settled it. */
  done: string;
}

/**
 * Submits a command. On success every cached resource is refreshed, since one transaction can move
 * balances, positions and the ledger at once.
 */
export function useCommand(onSettled?: () => void) {
  const queryClient = useQueryClient();
  const { notify } = useToast();

  return useMutation({
    mutationFn: (command: Command) => api.post<CommandResult>(command.path, command.body),
    onSuccess: async (result, command) => {
      await queryClient.invalidateQueries();
      const detail = result.txHash ? `Block ${result.blockNumber} · ${shortHash(result.txHash)}` : undefined;
      notify("good", command.done, detail);
      onSettled?.();
    },
    onError: (error) => notify("critical", "The command was not accepted", describeError(error)),
  });
}
