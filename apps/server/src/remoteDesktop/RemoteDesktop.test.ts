import { describe, expect, it } from "@effect/vitest";
import { RemoteDesktopError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as RemoteDesktop from "./RemoteDesktop.ts";
import * as NativeHost from "./NativeHost.ts";

const fixture = Effect.fn("fixture")(function* (
  options: {
    available?: boolean;
    frame?: Effect.Effect<{ width: number; height: number; jpeg: string }, RemoteDesktopError>;
    start?: NativeHost.NativeHost["Service"]["start"];
  } = {},
) {
  const inputs: unknown[] = [];
  let stops = 0;
  const host = NativeHost.NativeHost.of({
    available: options.available ?? true,
    start: options.start ?? Effect.succeed({ width: 1440, height: 900 }),
    frame: options.frame ?? Effect.succeed({ width: 1280, height: 800, jpeg: "test" }),
    input: (events) =>
      Effect.sync(() => {
        inputs.push(events);
      }),
    stop: Effect.sync(() => {
      stops++;
    }),
  });
  const service = yield* RemoteDesktop.RemoteDesktop.pipe(
    Effect.provide(
      RemoteDesktop.layer.pipe(Layer.provide(Layer.succeed(NativeHost.NativeHost, host))),
    ),
  );
  return { service, inputs, stops: () => stops };
});

describe("remote desktop leases", () => {
  it.effect("rejects disabled hosts and excludes competing viewers and replayed input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const disabled = yield* fixture({ available: false });
        expect((yield* disabled.service.start("a").pipe(Effect.flip)).reason).toBe("unavailable");
        const { service, inputs } = yield* fixture();
        const session = yield* service.start("a");
        expect((yield* service.start("b").pipe(Effect.flip)).reason).toBe("busy");
        expect((yield* service.frame("b", session.leaseId).pipe(Effect.flip)).reason).toBe(
          "expired",
        );
        expect((yield* service.stop("b", session.leaseId).pipe(Effect.flip)).reason).toBe(
          "expired",
        );
        const input = {
          leaseId: session.leaseId,
          sequence: 1,
          events: [{ type: "release" as const }],
        };
        expect((yield* service.control("b", input).pipe(Effect.flip)).reason).toBe("expired");
        yield* service.control("a", input);
        expect((yield* service.control("a", input).pipe(Effect.flip)).reason).toBe("sequence");
        expect(inputs).toHaveLength(1);
        yield* service.stop("a", session.leaseId);
        const next = yield* service.start("a");
        expect(next.leaseId).not.toBe(session.leaseId);
        expect(
          (yield* service.control("a", { ...input, sequence: 2 }).pipe(Effect.flip)).reason,
        ).toBe("expired");
      }),
    ),
  );

  it.effect("expires inactive control and disconnects only its owning connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, stops } = yield* fixture();
        const session = yield* service.start("a");
        yield* service.disconnect("b");
        expect((yield* service.status).busy).toBe(true);
        yield* TestClock.adjust("11 seconds");
        expect((yield* service.frame("a", session.leaseId).pipe(Effect.flip)).reason).toBe(
          "expired",
        );
        expect(stops()).toBeGreaterThan(0);
        yield* service.start("a");
        yield* service.disconnect("a");
        expect((yield* service.status).busy).toBe(false);
      }),
    ),
  );

  it.effect("discards a capture that completes after stop and frees a failed host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const result = yield* Deferred.make<
          { width: number; height: number; jpeg: string },
          RemoteDesktopError
        >();
        const { service } = yield* fixture({
          frame: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(result))),
        });
        const session = yield* service.start("a");
        const pending = yield* service
          .frame("a", session.leaseId)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* service.stop("a", session.leaseId);
        yield* Deferred.succeed(result, { width: 1, height: 1, jpeg: "late" });
        expect((yield* Fiber.join(pending)).reason).toBe("expired");
        expect((yield* service.status).busy).toBe(false);
        const broken = yield* fixture({
          frame: Effect.fail(new RemoteDesktopError({ reason: "permission" })),
        });
        const next = yield* broken.service.start("a");
        expect((yield* broken.service.frame("a", next.leaseId).pipe(Effect.flip)).reason).toBe(
          "permission",
        );
        expect((yield* broken.service.status).busy).toBe(false);
      }),
    ),
  );

  it.effect("retires a start that returns after its connection closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<{ width: number; height: number }>();
        const { service } = yield* fixture({
          start: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(ready))),
        });
        const pending = yield* service.start("a").pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* service.disconnect("a");
        yield* Deferred.succeed(ready, { width: 100, height: 100 });
        expect((yield* Fiber.join(pending)).reason).toBe("expired");
        expect((yield* service.status).busy).toBe(false);
      }),
    ),
  );
});
