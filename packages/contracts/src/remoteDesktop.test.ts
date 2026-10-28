import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { RemoteDesktopControlInput } from "./remoteDesktop.ts";

it("bounds remote input, rejects non-finite coordinates and arbitrary key codes", () => {
  const valid = Schema.is(RemoteDesktopControlInput);
  const input = (event: unknown) => ({ leaseId: "lease", sequence: 0, events: [event] });
  const pointer = { type: "pointer", phase: "down", button: "left", x: 0.5, y: 1 };
  expect(valid(input(pointer))).toBe(true);
  for (const x of [-1, 1.01, Infinity, NaN]) expect(valid(input({ ...pointer, x }))).toBe(false);
  expect(valid(input({ type: "text", text: "a".repeat(2001) }))).toBe(false);
  expect(valid(input({ type: "key", key: 42 }))).toBe(false);
  expect(
    valid({ ...input(pointer), events: Array.from({ length: 33 }, () => ({ ...pointer })) }),
  ).toBe(false);
  expect(valid({ ...input(pointer), sequence: -1 })).toBe(false);
});
