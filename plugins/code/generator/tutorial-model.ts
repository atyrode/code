/*
 * THE TUTORIAL: a welcome, then a short walk through the panel in the order a person uses it, one real
 * control at a time, offered once per person and replayed from More. Each step names what it lights
 * with its own selectors, in the order the layout may show it (a pane beside the generator, else its
 * tab, else its Show control), so the same walk serves every width. A step whose control is not
 * shown is passed over, and the progress counts the steps the walk has now. Pure, so the walk's order
 * and bounds are tested apart from the layer that draws it (tutorial.tsx).
 */

/** Generator-panel class prefix; the selectors below name parts of the panel by it. */
const G = "plugin-atyrode_code_generator__";

/** What the welcome says before the walk: what Code is, in a sentence, and the offer. */
export const TUTORIAL_WELCOME = {
  title: "Welcome to Code",
  text: "Code starts OMP coding sessions on your machines, with the models you choose here. A short tour shows you around.",
  take: "Take the tour",
  skip: "Skip",
} as const;

/** Something the person may try at a step, which takes the walk on once done: choosing a word, or opening the accounts. */
export type TutorialTry = "word" | "accounts";
export type TutorialStep = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /**
   * What the step lights: the first of these the panel shows, each a list of selectors whose elements
   * the opening takes in together; an entry shows when its first selector finds a shown element.
   */
  readonly targets: readonly (readonly string[])[];
  /** What the person may try through the opening; a step with none only shows its control. */
  readonly tries?: TutorialTry;
};

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  { id: "profile", title: "Your profile", text: "These words choose which models do the work and how hard they think. Point at one to see what it would change, and click to choose it.",
    targets: [[`[data-pane="generator"] .${G}dials`, `[data-pane="generator"] .${G}readout`]], tries: "word" },
  { id: "estimates", title: "Cost and speed", text: "What this profile costs, as a relative list price, and how fast it answers once a model check has measured it.",
    targets: [[`[data-pane="generator"] .${G}meter`]] },
  { id: "routing", title: "Routing", text: "Each role in a session and the model it gets from your profile.",
    targets: [[`[data-pane="routing"]`], [`[data-view-tab="routing"]`], [`[data-reveal][aria-keyshortcuts="p"]`]] },
  { id: "usage", title: "Usage", text: "How much each account has left, over 5 hours and over a week.",
    targets: [[`[data-pane="usage"]`], [`[data-view-tab="usage"]`], [`[data-reveal][aria-keyshortcuts="s"]`]] },
  { id: "launch", title: "Launch", text: "Choose the machine, then launch: a terminal opens there with OMP running, ready for your task. The first launch checks your models once, after asking you.",
    targets: [[`[data-pane="generator"] .${G}launch-what`]] },
  { id: "accounts", title: "Accounts", text: "Which of your accounts this workspace may use. Open it to see.", targets: [[`[data-view-tab="accounts"]`]], tries: "accounts" },
  { id: "sessions", title: "Sessions", text: "What is running, with live dials, and saved sessions to reopen.", targets: [[`[data-view-tab="sessions"]`]] },
  { id: "more", title: "More", text: "Models, Setup, Options and Shortcuts live here, and Tutorial takes this tour again.", targets: [["[data-more]"]] },
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
