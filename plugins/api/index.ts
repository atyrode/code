/**
 * CODE'S DOOR CONTRACT, for a plugin that depends on Code.
 *
 * The same shape Code itself consumes OMP through: one entry point, typed schemas, no server
 * modules. A dependent plugin's server calls these doors with `ctx.actions.call` under the
 * principal of the request it is answering (ADR 0041); a dependent plugin's panel calls them
 * through the operator's own session with `actionDoor` (ADR 0013). Code composes the session,
 * chooses the account and reaches OMP; a caller supplies a profile, a destination and a prompt.
 *
 * What resolves where: `zod` and `@atyrode/manifold-omp` come with this package, `@manifold/*`
 * comes from the consumer's own SDK checkout — the arrangement every Manifold plugin already
 * has, and the one Code itself uses for OMP.
 */
export {
  /** The plugin whose doors these are, and the two surfaces a caller links a reader to. */
  CODE_PLUGIN_ID,
  GENERATOR_PLUGIN_ID,
  LAUNCHER_PANEL,
  /** The event Code emits when a container's shared configuration moves. */
  CODE_PREFERENCES_EVENT,
  /** `${CODE_PLUGIN_ID}.${action}`: the door name an ordinary client dispatches. */
  actionDoor,
  /** Every published door, input and result. `listProfiles`, `runSession`, `readSession` and
   * `cancelSession` are the job-shaped session; the rest is the configuration a profile is
   * made of. A run is watched through `readSession`, whose receipt is null until it exited 0. */
  actionSchemas,
  /** A Code refusal is `code_` followed by its own token, the way an OMP refusal is `omp_`:
   * a caller that carries this word keeps both the plugin that refused and the reason. */
  RefusalSchema,
  /** The typed ordinary-client adapter. It neither grants nor proxies native authority. */
  createCodeClient,
  /** A profile is a configured workspace; these are what `listProfiles` answers. `accounts` is
   * what Code says the profile spends, and `resolved` says whether a live observation backed
   * it — a caller displays Code's answer rather than inferring an account of its own. */
  ProfileSchema,
  ProfileModelSchema,
  ProfileAccountSchema,
  ProfileListSchema,
  /** The session doors' inputs, and the composition a run is made from. `readSession` answers
   * a run at any point in its life, `cancelSession` ends one; both name a job Code posted. */
  SessionRunInputSchema,
  SessionReadInputSchema,
  SessionCancelInputSchema,
  SessionCompositionSchema,
  /** A workspace, and a workspace plus the destination a caller chose for it. */
  WorkspaceSchema,
  TargetSchema,
  RevisionTargetSchema,
  /** The primitives every schema above is built from. */
  digest,
  id,
  revision,
  type ActionInput,
  type ActionReply,
  type ActionResult,
  type CodeAction,
  type Profile,
  type ProfileAccount,
  type SessionComposition,
  type Target,
  type Workspace,
} from "../atyrode.code/contract.ts";
