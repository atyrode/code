/*
 * THE TUTORIAL: a short walk through the panel, one real control at a time, offered once per person
 * and replayed from More. Each step names what it points at with its own selectors, in the order the
 * layout may show it (a pane beside the generator, else its tab, else its Show control), so the same
 * walk serves every width. A step whose control is not shown is passed over, and the count says how
 * many the walk has now. Pure, so the walk's order and bounds are tested apart from the card that
 * draws it (tutorial.tsx).
 */

/** Generator-panel class prefix; the selectors below name parts of the panel by it. */
const G = "plugin-atyrode_code_generator__";

/** Something the person may try at a step, which takes the walk on once done: choosing a word, or opening the accounts. */
export type TutorialTry = "word" | "accounts";
export type TutorialStep = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** Where the step points: the first of these the panel shows. */
  readonly targets: readonly string[];
  readonly tries?: TutorialTry;
};

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  { id: "rows", title: "Your profile", text: "These words choose which models do the work and how hard they think. Click one to try it.",
    targets: [`[data-pane="generator"] .${G}dials`], tries: "word" },
  { id: "readout", title: "What it would do", text: "This line says what anything you point at would change, quota included.",
    targets: [`[data-pane="generator"] .${G}readout`] },
  { id: "defaults", title: "Defaults and Revert", text: "Defaults gives the standard profile. After a change, Revert brings back the saved one.",
    targets: [`[data-pane="generator"] [data-defaults]`] },
  { id: "routing", title: "Routing", text: "Each role in a session and the model it gets.",
    targets: [`[data-pane="routing"]`, `[data-view-tab="routing"]`, `[data-reveal][aria-keyshortcuts="p"]`] },
  { id: "usage", title: "Usage", text: "How much of each account's quota is left, over 5 hours and over a week.",
    targets: [`[data-pane="usage"]`, `[data-view-tab="usage"]`, `[data-reveal][aria-keyshortcuts="s"]`] },
  { id: "machine", title: "Machine", text: "Where the session runs.", targets: ["[data-machine-picker]"] },
  { id: "launch", title: "Launch", text: "Opens a terminal on that machine with OMP running; you type your task there. The first launch checks your models once, after asking you.",
    targets: [`[data-pane="generator"] button.${G}launch`] },
  { id: "accounts", title: "Accounts", text: "Which of your accounts this workspace may use. Open it to see.", targets: [`[data-view-tab="accounts"]`], tries: "accounts" },
  { id: "sessions", title: "Sessions", text: "What is running, with live dials, and saved sessions to reopen.", targets: [`[data-view-tab="sessions"]`] },
  { id: "more", title: "More", text: "Models, Setup, Options and Shortcuts. Replay this tutorial here any time.", targets: ["[data-more]"] },
];

/** Where the walk stands among the steps shown now: 1-based, and how many there are; null when the step is not shown. */
export function tutorialPlace(shown: readonly boolean[], step: number): { readonly position: number; readonly count: number } | null {
  if (!shown[step]) return null;
  return { position: shown.slice(0, step + 1).filter(Boolean).length, count: shown.filter(Boolean).length };
}
/** The next step shown after `step` (from the start for -1); null past the last, which ends the walk. */
export function nextTutorialStep(shown: readonly boolean[], step: number): number | null {
  for (let next = step + 1; next < shown.length; next++) if (shown[next]) return next;
  return null;
}
/** The step shown before `step`; null at the first. */
export function previousTutorialStep(shown: readonly boolean[], step: number): number | null {
  for (let previous = step - 1; previous >= 0; previous--) if (shown[previous]) return previous;
  return null;
}
