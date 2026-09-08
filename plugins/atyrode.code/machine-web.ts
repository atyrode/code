import { useEffect, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import { PublicJobSchema, type MachineSummary, type PublicJob } from "@manifold/protocol";
import {
  CODE_PREFERENCES_TOPIC, PREPARE_LAUNCH_DOOR, PrepareLaunchInputSchema, PrepareLaunchResultSchema,
  type PrepareLaunchInput,
} from "./contract.ts";
import {
  CODE_APPLY_ACCOUNT_CHOICES_DOOR, CODE_JOB_TOPIC, CODE_OBSERVE_DOOR, CODE_RUN_DOOR,
  CodeApplyAccountChoicesInputSchema, CodeApplyAccountChoicesResultSchema, CodeObservationSchema, CodeRunInputSchema,
  type CodeApplyAccountChoicesInput, type CodeObservation, type CodeOperation, type CodeOperationInput,
} from "./machine-contract.ts";

type FailureKind = "denied" | "unavailable" | "invalid" | "stale" | "large" | "preview" | "mode" | "catalog" | "preferences";
const failureMessages: Record<FailureKind, string> = {
  denied: "This operation needs current machine authority and explicit plugin consent.",
  unavailable: "The governed Code backend is unavailable.",
  invalid: "The Code request or response did not match its contract.",
  stale: "Shared account choices changed. Read the current state and review again.",
  large: "This request exceeds the native execution or terminal argument bound.",
  preview: "The reviewed preview no longer matches this launch. Request a new preview.",
  mode: "The requested launch mode is not available on this machine.",
  catalog: "The selected machine does not have a runnable Code catalog.",
  preferences: "Save or explicitly import shared choices in Code accounts before using them, or choose existing CLI settings.",
};
const refusalKinds = new Map<string, FailureKind>([
  ["code_stale_preferences", "stale"], ["code_input_too_large", "large"],
  ["code_preview_changed", "preview"], ["code_launch_mode_unavailable", "mode"],
  ["code_catalog_missing", "catalog"], ["code_invalid_request", "invalid"],
  ["code_operation_unavailable", "unavailable"], ["code_observation_unavailable", "unavailable"],
  ["code_preferences_missing", "preferences"],
]);

class CodeOperationError extends Error {
  constructor(kind: FailureKind) { super(failureMessages[kind]); }
}

export function codeOperationFailure(reason: unknown): string {
  return reason instanceof CodeOperationError ? reason.message : "The Code operation could not be completed.";
}

async function action(host: HostServices, door: string, input: unknown): Promise<unknown> {
  const outcome = await host.client.action(door, input);
  if (!outcome.ok)
    throw new CodeOperationError(refusalKinds.get(outcome.denial.message) ?? (outcome.denial.rule === "unavailable" ? "unavailable" : "denied"));
  return outcome.result;
}

export function useCodeMachines(host: HostServices) {
  const [error, setError] = useState<string | null>(null);
  const { value: machines, refresh } = usePolledResource<readonly MachineSummary[] | null>(
    () => host.client.machines(), FALLBACK_POLL_MS,
    {
      key: MACHINES_RESOURCE,
      restartKey: host.principal.id,
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
export function useCodeOperation<K extends CodeOperation>(host: HostServices, machineId: string | null, operation: K, jobId?: string) {
  const { value, refresh } = usePolledResource<ReadResult<K> | null>(
    async () => {
      try {
        const observation = CodeObservationSchema.parse(await action(host, CODE_OBSERVE_DOOR, { machineId, operation, ...(jobId === undefined ? {} : { jobId }) }));
        if (observation.operation !== operation) throw new Error("Mismatched observation");
        return { observation: observation as Observation<K>, error: null };
      } catch {
        return { observation: null, error: "The Code observation could not be read under the current authority." };
      }
    }, FALLBACK_POLL_MS,
    {
      key: `${CODE_OBSERVE_DOOR}:${JSON.stringify([machineId, operation, jobId])}`,
      restartKey: host.principal.id,
      initial: null,
      enabled: machineId !== null,
      topics: [CODE_JOB_TOPIC, CODE_PREFERENCES_TOPIC],
      events: host.client,
    },
  );
  return { observation: value?.observation ?? null, error: value?.error ?? null, refresh };
}

export async function runCodeOperation<K extends CodeOperation>(
  host: HostServices, machineId: string, operation: K, input: CodeOperationInput<K>,
): Promise<PublicJob> {
  try {
    const args = CodeRunInputSchema.parse({ machineId, operation, input });
    return PublicJobSchema.parse(await action(host, CODE_RUN_DOOR, args));
  } catch (reason) {
    if (reason instanceof CodeOperationError) throw reason;
    throw new CodeOperationError("invalid");
  }
}

export async function applyCodeAccountChoices(host: HostServices, input: CodeApplyAccountChoicesInput) {
  const args = CodeApplyAccountChoicesInputSchema.parse(input);
  return CodeApplyAccountChoicesResultSchema.parse(await action(host, CODE_APPLY_ACCOUNT_CHOICES_DOOR, args));
}

export async function prepareCodeLaunch(host: HostServices, input: PrepareLaunchInput) {
  const args = PrepareLaunchInputSchema.parse(input);
  return PrepareLaunchResultSchema.parse(await action(host, PREPARE_LAUNCH_DOOR, args));
}
