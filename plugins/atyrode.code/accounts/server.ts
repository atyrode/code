import { defineAction } from "@manifold/plugin";
import { z } from "zod";
import { prepareSignIn, promoteAccountRuntime, readAccountSetup, reviewAccountRuntime } from "../auth-server.ts";
import { accountActionSchemas, type AccountAction, type ActionInput, type ActionResult } from "../contract.ts";
import { CodeRefusal, type CodeContext } from "../machine-server.ts";

type AccountHandlers = { [K in AccountAction]: (ctx: CodeContext, args: ActionInput<K>) => Promise<ActionResult<K>> };
const accountHandlers: AccountHandlers = { readAccountSetup, prepareSignIn, reviewAccountRuntime, promoteAccountRuntime };
export const handlers = Object.fromEntries((Object.keys(accountActionSchemas) as AccountAction[]).map(name => [name,
  async (ctx: CodeContext, raw: unknown) => {
    try {
      const args = accountActionSchemas[name].input.parse(raw);
      const handler = accountHandlers[name] as (context: CodeContext, input: typeof args) => Promise<unknown>;
      return accountActionSchemas[name].result.parse(await handler(ctx, args));
    } catch (error) {
      if (error instanceof CodeRefusal) return { refused: error.message };
      if (error instanceof z.ZodError) return { refused: "code_invalid_request" };
      return { refused: "code_operation_unavailable" };
    }
  },
]));
export default { actions: [
  defineAction({ name: "readAccountSetup", title: "Read Account Setup", caps: ["services:read"],
    delegates: ["services:read", "services:configure", "machines:run"], scope: "workspace", trace: "opaque",
    ...accountActionSchemas.readAccountSetup }),
  defineAction({ name: "prepareSignIn", title: "Prepare Sign In", caps: ["containers:write"],
    delegates: ["services:read", "services:configure", "machines:run"], scope: "container", trace: "opaque",
    ...accountActionSchemas.prepareSignIn }),
  defineAction({ name: "reviewAccountRuntime", title: "Review Account Runtime", caps: ["services:configure"],
    delegates: ["services:read", "services:configure", "machines:run"], scope: "workspace", trace: "opaque",
    ...accountActionSchemas.reviewAccountRuntime }),
  defineAction({ name: "promoteAccountRuntime", title: "Promote Account Runtime", caps: ["containers:write"],
    delegates: ["services:read", "services:configure", "machines:run"], scope: "container", trace: "opaque",
    ...accountActionSchemas.promoteAccountRuntime }),
], handlers };
