import { useId } from "react";
import { RESTRICTED_TOOL_NAMES, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";

export type AutomationChoice = OmpInput<"reviewSession">["automation"];
export function Automation({ choice, reviewed, disabled, change }: {
  choice: AutomationChoice; reviewed: OmpResult<"reviewSession">["automation"] | null;
  disabled: boolean; change: (choice: AutomationChoice) => void;
}) {
  const group = useId();
  return <section className="plugin-atyrode_code_generator__automation" aria-label="Automation policy">
    <h3>Automation policy</h3>
    <fieldset disabled={disabled}>
      <legend>For this launch or resume only</legend>
      <label><input type="radio" name={group} checked={!choice} onChange={() => change(undefined)} />Ordinary session</label>
      <label><input type="radio" name={group} checked={!!choice} onChange={() => change({ mode: "restricted", toolNames: [], delegation: "disabled" })} />Restricted automation</label>
    </fieldset>
    {choice && <fieldset disabled={disabled}>
      <legend>Allowed native tools · none selected means no tools</legend>
      {RESTRICTED_TOOL_NAMES.map(name => <label key={name}><input type="checkbox" checked={choice.toolNames.includes(name)} onChange={event => change({ ...choice,
        toolNames: event.target.checked ? [...choice.toolNames, name] : choice.toolNames.filter(tool => tool !== name) })} />{name}</label>)}
    </fieldset>}
    {choice && <p>Task delegation and ambient skills are off. Only deliberately selected sealed skills can load.</p>}
    {choice && <p>Set Advisor, Prewalk and Fallbacks to Off, and Plans to Ask first; save the profile before reviewing.</p>}
    <details className="plugin-atyrode_code__details"><summary>Policy boundaries and resume</summary>
      <p>Tool limits are not an OS or network sandbox. Allowed bash can execute programs, including another OMP process, under the separately granted native authority. Disabling OMP task delegation does not prohibit shell subprocesses. File tools retain their native authority; skills grant none.</p>
      <p>Resume does not restore historical restrictions. Choose restricted mode again when needed. Saved-state resume uses OMP defaults and refuses if advisor, prewalk or fallback remains enabled. Choosing restricted mode changes neither profile nor defaults.</p>
    </details>
    {reviewed && <div role="status" data-effective-automation={reviewed.mode}>
      <h4>Native-reviewed effective policy</h4>
      {reviewed.mode === "restricted" ? <p>Restricted · tools: {reviewed.toolNames.join(", ") || "none"} · OMP task delegation: {reviewed.delegation} · ambient discovery suppressed</p> : <p>Ordinary session · native defaults apply</p>}
    </div>}
  </section>;
}
