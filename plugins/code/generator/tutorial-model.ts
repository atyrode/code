/*
 * THE TUTORIAL: a welcome, then a short walk through the panel in the order a person uses it, one real
 * control at a time, offered once per person and replayed from More. Each step names what it lights
 * with its own selectors, in the order the layout may show it (a pane beside the generator, else its
 * tab, else its Show control), so the same walk serves every width. A step whose control is not shown
 * when the walk begins is passed over, and the progress counts the steps the walk has. Pure, so the
 * walk's order and bounds are tested apart from the layer that draws it (tutorial.tsx).
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

/** One thing a step may light: selectors whose shown elements the opening takes in together. */
export type TutorialTarget = {
  /** It shows when its first selector finds a shown element; the rest join it where they show. */
  readonly parts: readonly string[];
  /** Whether what it lights answers the person through the opening (a word to choose, a tab to open); otherwise it is only shown. */
  readonly tryable?: true;
};
export type TutorialStep = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** What the step lights: the first of these the panel shows. */
  readonly targets: readonly TutorialTarget[];
  /** A step that goes on by itself once the person has done what it invites: chosen a word through its opening. */
  readonly goesOn?: "word";
};

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  { id: "profile", title: "Your profile", text: "These words choose which models do the work and how hard they think. The line under them says what a word would change; choose one to try it.",
    targets: [{ parts: [`[data-pane="generator"] .${G}dials`, `[data-pane="generator"] .${G}readout`], tryable: true }], goesOn: "word" },
  { id: "estimates", title: "Cost and speed", text: "What this profile costs, as a relative list price, and how fast it answers once a model check has measured it.",
    targets: [{ parts: [`[data-pane="generator"] .${G}meter`] }] },
  // Where the layout keeps routing and usage behind a tab or a Show control, that is lit and may be opened, and the opening
  // then glides to the pane it shows; the walk waits for Next.
  { id: "routing", title: "Routing", text: "Each role in a session and the model it gets from your profile.",
    targets: [{ parts: [`[data-pane="routing"]`] }, { parts: [`[data-view-tab="routing"]`], tryable: true }, { parts: [`[data-reveal][aria-keyshortcuts="p"]`], tryable: true }] },
  { id: "usage", title: "Usage", text: "How much each account has left, over 5 hours and over a week.",
    targets: [{ parts: [`[data-pane="usage"]`] }, { parts: [`[data-view-tab="usage"]`], tryable: true }, { parts: [`[data-reveal][aria-keyshortcuts="s"]`], tryable: true }] },
  { id: "launch", title: "Launch", text: "Choose the machine, then launch: a terminal opens there with OMP running, ready for your task. If your models are not checked yet, it checks them first.",
    targets: [{ parts: [`[data-pane="generator"] .${G}launch-what`] }] },
  // Opened, the accounts show under the opening, which glides from the tab to them; the walk waits for Next.
  { id: "accounts", title: "Accounts", text: "Which of your accounts this workspace may use. Open it to see.",
    targets: [{ parts: [`[data-pane="accounts"]`] }, { parts: [`[data-view-tab="accounts"]`], tryable: true }] },
  { id: "sessions", title: "Sessions", text: "What is running, with live dials, and saved sessions to reopen.", targets: [{ parts: [`[data-view-tab="sessions"]`] }] },
  { id: "more", title: "More", text: "Models, Setup, Options and Shortcuts live here, and Tutorial takes this tour again.", targets: [{ parts: ["[data-more]"] }] },
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
