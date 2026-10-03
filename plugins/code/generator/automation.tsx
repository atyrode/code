import { RESTRICTED_TOOL_NAMES, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { OptionSwitch } from "./option-switch.tsx";

const G = "plugin-atyrode_code_generator__";

export type AutomationChoice = OmpInput<"reviewSession">["automation"];

/**
 * Automation for the next launch or resume, in the session options sheet: one switch restricts it,
 * and then every native tool it may use is a switch of its own. What a restriction does and does not
 * promise is always said, and once a launch was reviewed, the policy the native review made effective.
 */
export function Automation({ choice, reviewed, refusal, change }: {
  choice: AutomationChoice; reviewed: OmpResult<"reviewSession">["automation"] | null;
  /** Why the switches are refused now; null when they act. */
  refusal: string | null; change: (choice: AutomationChoice) => void;
}) {
  return <section className={`${G}options-group`} aria-label="Automation policy">
    <h3 className={`${G}options-head`}>automation</h3>
    <OptionSwitch on={!!choice} refusal={refusal} onChange={on => change(on ? { mode: "restricted", toolNames: [], delegation: "disabled" } : undefined)}>
      restricted automation
    </OptionSwitch>
    <p className={`${G}options-note`}>{choice ? "Only the tools switched on below; with none, no tools." : "An ordinary session: native defaults apply."}</p>
    {choice && <ul className={`${G}options-switches`} aria-label="Allowed native tools">
      {RESTRICTED_TOOL_NAMES.map(name => <li key={name}>
        <OptionSwitch on={choice.toolNames.includes(name)} refusal={refusal}
          onChange={on => change({ ...choice, toolNames: on ? [...choice.toolNames, name] : choice.toolNames.filter(tool => tool !== name) })}>{name}</OptionSwitch>
      </li>)}
    </ul>}
    {choice && <p className={`${G}options-note`} data-tone="warn">Restricted OMP tools; not an OS or network sandbox.</p>}
    {choice && <p className={`${G}options-note`}>Task delegation and ambient skills are off; only deliberately selected sealed skills can load. Set advisor, prewalk and fallbacks to off and plans to ask first, then save the profile before reviewing.</p>}
    <p className={`${G}options-note`} data-tone="meta">{choice ? "" : "Tool limits are not an OS or network sandbox. "}Allowed bash can execute programs, including another OMP process, under the separately granted native authority. Disabling OMP task delegation does not prohibit shell subprocesses. File tools retain their native authority; skills grant none.</p>
    <p className={`${G}options-note`} data-tone="meta">Resume does not restore historical restrictions; choose restricted automation again when needed. Saved-state resume uses OMP defaults and refuses if advisor, prewalk or fallbacks remain on. Restricting changes neither the profile nor the defaults.</p>
    {reviewed && <p className={`${G}options-note`} role="status" data-effective-automation={reviewed.mode}>
      {reviewed.mode === "restricted"
        ? `Reviewed natively: restricted · tools ${reviewed.toolNames.join(", ") || "none"} · OMP task delegation ${reviewed.delegation} · ambient discovery suppressed`
        : "Reviewed natively: an ordinary session · native defaults apply"}
    </p>}
  </section>;
}
