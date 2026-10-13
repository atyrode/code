import { describe, expect, test } from "bun:test";
import { nextTutorialStep, previousTutorialStep, tutorialPlace } from "../code/generator/tutorial-model.ts";

describe("the tutorial's walk", () => {
  // Five steps, the second and the fourth not shown now (another layout puts them in tabs the panel does not show).
  const shown = [true, false, true, false, true];

  test("it walks only the steps the panel shows, and ends past the last", () => {
    expect(nextTutorialStep(shown, -1)).toBe(0);
    expect(nextTutorialStep(shown, 0)).toBe(2);
    expect(nextTutorialStep(shown, 2)).toBe(4);
    expect(nextTutorialStep(shown, 4)).toBeNull();
    expect(previousTutorialStep(shown, 4)).toBe(2);
    expect(previousTutorialStep(shown, 0)).toBeNull();
  });

  test("where it stands counts only the steps shown, and a step not shown has no place", () => {
    expect(tutorialPlace(shown, 2)).toEqual({ position: 2, count: 3 });
    expect(tutorialPlace(shown, 4)).toEqual({ position: 3, count: 3 });
    expect(tutorialPlace(shown, 1)).toBeNull();
  });
});
