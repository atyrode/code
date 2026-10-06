import { describe, expect, test } from "bun:test";
import { CREDENTIAL_DISABLED, pressSwitch, SAVING, settlePress, switchLock, type SwitchPress } from "../code/generator/account-switch.ts";

const open = { refusal: null, preset: null, historical: false } as const;
const row = { included: true, disabled: false };

describe("account switches", () => {
  test("a press locks the switches until the saved choices answer it, then the next press makes its edit", () => {
    const made: SwitchPress = { key: "ada", enabled: false, revision: 5, started: false };
    const inFlight = settlePress(made, { pending: true, failure: null, revision: 5 });
    expect(inFlight).toEqual({ ...made, started: true });
    // The edit has landed but its read has not: the press stands, so a second press is refused aloud rather than sent at revision 5.
    const landed = settlePress(inFlight, { pending: false, failure: null, revision: 5 });
    expect(landed).toBe(inFlight);
    const lock = switchLock({ ...open, saving: landed !== null });
    expect(lock).toBe(SAVING);
    expect(pressSwitch({ ...row, included: false }, lock)).toEqual({ kind: "refuse", reason: SAVING });
    // The read past it answers the press, and the switch acts again.
    const answered = settlePress(landed, { pending: false, failure: null, revision: 6 });
    expect(answered).toBeNull();
    expect(pressSwitch({ ...row, included: false }, switchLock({ ...open, saving: answered !== null }))).toEqual({ kind: "change", enabled: true });
  });

  test("a press whose edit failed, was refused or never started is answered at once", () => {
    const made: SwitchPress = { key: "ada", enabled: false, revision: 5, started: false };
    expect(settlePress(made, { pending: false, failure: null, revision: 5 })).toBeNull();
    expect(settlePress({ ...made, started: true }, { pending: false, failure: "The account list is not current.", revision: 5 })).toBeNull();
    expect(settlePress({ ...made, started: true }, { pending: false, failure: null, revision: null })).toBeNull();
  });

  test("every lock refuses a press with its reason; none drops it unsaid", () => {
    const locks = [
      switchLock({ ...open, refusal: "Read-only access.", saving: true }),
      switchLock({ ...open, saving: true }),
      switchLock({ ...open, saving: false, preset: "Night" }),
      switchLock({ ...open, saving: false, historical: true }),
    ];
    expect(locks[0]).toBe("Read-only access.");
    for (const lock of locks) {
      expect(lock).not.toBeNull();
      expect(pressSwitch(row, lock)).toEqual({ kind: "refuse", reason: lock! });
    }
    expect(pressSwitch({ ...row, disabled: true }, null)).toEqual({ kind: "refuse", reason: CREDENTIAL_DISABLED });
  });
});
