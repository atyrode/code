import { ACCOUNTS_PLUGIN_ID } from "./contract.ts";

export const BROKER_SERVICE_ID = `${ACCOUNTS_PLUGIN_ID}.broker`;
export const BROKER_OPERATION_ID = `${ACCOUNTS_PLUGIN_ID}.broker`;
export const SIGN_IN_OPERATION_ID = `${ACCOUNTS_PLUGIN_ID}.sign-in`;

/** Registry identity, not a policy hash or a workspace-selected worker. */
export interface SharedBrokerReference {
  serviceId: string;
  revision: string;
  machineId: string;
}
