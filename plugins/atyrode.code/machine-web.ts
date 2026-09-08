import { useEffect, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import { PublicJobSchema, type MachineSummary, type PublicJob } from "@manifold/protocol";
import {
  CODE_JOB_TOPIC, CODE_OBSERVE_DOOR, CODE_RUN_DOOR,
  CodeObservationSchema, CodeRunInputSchema,
  type CodeObservation, type CodeOperation, type CodeOperationInput,
} from "./machine-contract.ts";

async function action(host: HostServices, door: string, input: unknown): Promise<unknown> {
  const outcome = await host.client.action(door, input);
  if (!outcome.ok) throw new Error(outcome.denial.message);
  if (typeof outcome.result === "object" && outcome.result !== null && "refused" in outcome.result)
    throw new Error("The Code operation was refused by the runtime.");
  return outcome.result;
}

export function useCodeMachines(host: HostServices) {
  const [error, setError] = useState<string | null>(null);
  const { value: machines, refresh } = usePolledResource<readonly MachineSummary[] | null>(
    () => host.client.machines(), FALLBACK_POLL_MS,
    {
      key: MACHINES_RESOURCE,
      initial: null,
      topics: host.topics.machines,
      events: host.client,
      onError: () => setError("The machine list could not be read."),
    },
  );
  useEffect(() => { setError(null); }, [machines]);
  return { machines, error, refresh };
}

type Observation<K extends CodeOperation> = Extract<CodeObservation, { operation: K }>;
type ReadResult<K extends CodeOperation> = { observation: Observation<K> | null; error: string | null };

/** The shared feed owns observation and reconnection; a render never starts a machine job. */
export function useCodeOperation<K extends CodeOperation>(host: HostServices, machineId: string | null, operation: K) {
  const { value, refresh } = usePolledResource<ReadResult<K> | null>(
    async () => {
      try {
        const observation = CodeObservationSchema.parse(await action(host, CODE_OBSERVE_DOOR, { machineId, operation }));
        if (observation.operation !== operation) throw new Error("Mismatched observation");
        return { observation: observation as Observation<K>, error: null };
      } catch {
        return { observation: null, error: "The Code observation could not be read under the current authority." };
      }
    }, FALLBACK_POLL_MS,
    {
      key: `${CODE_OBSERVE_DOOR}:${JSON.stringify([machineId, operation])}`,
      initial: null,
      enabled: machineId !== null,
      topics: [CODE_JOB_TOPIC],
      events: host.client,
    },
  );
  return { observation: value?.observation ?? null, error: value?.error ?? null, refresh };
}

export async function runCodeOperation<K extends CodeOperation>(
  host: HostServices, machineId: string, operation: K, input: CodeOperationInput<K>,
): Promise<PublicJob> {
  const args = CodeRunInputSchema.parse({ machineId, operation, input });
  return PublicJobSchema.parse(await action(host, CODE_RUN_DOOR, args));
}
