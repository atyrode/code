import { z } from "zod";
import { epochMilliseconds } from "@atyrode/manifold-omp";
import { id, type Tutorial } from "./contract.ts";
import type { CodeContext } from "./context.ts";
import { bound, personOf } from "./person.ts";

/*
  WHETHER A PERSON HAS SEEN THE TUTORIAL. The panel offers its tutorial once per person, on whichever
  device and in whichever workspace they first open it; finishing it, skipping it or leaving it marks
  it seen, and More replays it whenever they like. It is a person's own record (person.ts): nobody
  reads or writes another person's, and a caller that keeps none is answered as keeping none rather
  than refused, so the panel keeps it in the browser instead.
*/

const StoredTutorialSchema = z.strictObject({ schemaVersion: z.literal(1), principalId: id, seenAt: epochMilliseconds });
const tutorialKey = (person: string) => `tutorial/${person}`;

export async function readTutorial(ctx: CodeContext): Promise<Tutorial> {
  const person = await personOf(ctx);
  if (person === null) return { keeps: false, seenAt: null };
  const raw = await ctx.storage.get(tutorialKey(person));
  return { keeps: true, seenAt: raw === null ? null : bound(ctx, StoredTutorialSchema.parse(JSON.parse(raw))).seenAt };
}

/** Records that the caller has seen the tutorial, once: a record already there, from another tab or device, stands as it is. */
export async function seeTutorial(ctx: CodeContext): Promise<Tutorial> {
  const person = await personOf(ctx);
  if (person === null) return { keeps: false, seenAt: null };
  const record = StoredTutorialSchema.parse({ schemaVersion: 1, principalId: ctx.auth.principal.id, seenAt: ctx.now() });
  await ctx.storage.compareAndSet(tutorialKey(person), null, JSON.stringify(record));
  return readTutorial(ctx);
}
