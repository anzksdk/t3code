// @effect-diagnostics nodeBuiltinImport:off - Generates an unguessable lease for each desktop control session.
import * as NodeCrypto from "node:crypto";
import {
  RemoteDesktopError,
  type RemoteDesktopControlInput,
  type RemoteDesktopFrame,
  type RemoteDesktopSession,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as NativeHost from "./NativeHost.ts";

export class RemoteDesktop extends Context.Service<
  RemoteDesktop,
  {
    readonly status: Effect.Effect<{ available: boolean; busy: boolean }>;
    readonly start: (owner: string) => Effect.Effect<RemoteDesktopSession, RemoteDesktopError>;
    readonly frame: (
      owner: string,
      leaseId: string,
    ) => Effect.Effect<RemoteDesktopFrame, RemoteDesktopError>;
    readonly control: (
      owner: string,
      input: RemoteDesktopControlInput,
    ) => Effect.Effect<void, RemoteDesktopError>;
    readonly stop: (owner: string, leaseId: string) => Effect.Effect<void, RemoteDesktopError>;
    readonly disconnect: (owner: string) => Effect.Effect<void>;
  }
>()("t3/remoteDesktop/RemoteDesktop") {}

const make = Effect.gen(function* () {
  const host = yield* NativeHost.NativeHost;
  const lock = yield* Semaphore.make(1);
  let active: {
    owner: string;
    leaseId: string;
    expires: number;
    sequence: number;
    nextFrame: number;
  } | null = null;
  const clear = Effect.fn("RemoteDesktop.clear")(function* () {
    active = null;
    yield* host.stop;
  });
  const requireLease = Effect.fn("RemoteDesktop.requireLease")(function* (
    owner: string,
    leaseId: string,
  ) {
    const session = active;
    if (!session || session.owner !== owner || session.leaseId !== leaseId)
      return yield* new RemoteDesktopError({ reason: "expired" });
    if (session.expires <= (yield* Clock.currentTimeMillis)) {
      yield* clear();
      return yield* new RemoteDesktopError({ reason: "expired" });
    }
    return session;
  });
  yield* Effect.addFinalizer(() => clear());
  yield* Effect.gen(function* () {
    yield* Effect.sleep("1 second");
    if (active && active.expires <= (yield* Clock.currentTimeMillis)) yield* clear();
  }).pipe(Effect.forever, Effect.forkScoped);

  return RemoteDesktop.of({
    status: Effect.sync(() => ({ available: host.available, busy: active !== null })),
    start: Effect.fn("RemoteDesktop.start")(function* (owner) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (!host.available) return yield* new RemoteDesktopError({ reason: "unavailable" });
          if (active) return yield* new RemoteDesktopError({ reason: "busy" });
          const session = {
            owner,
            leaseId: NodeCrypto.randomUUID(),
            expires: (yield* Clock.currentTimeMillis) + 30_000,
            sequence: -1,
            nextFrame: 0,
          };
          active = session;
          const size = yield* host.start.pipe(Effect.onError(() => clear()));
          if (active !== session) return yield* new RemoteDesktopError({ reason: "expired" });
          session.expires = (yield* Clock.currentTimeMillis) + 10_000;
          return { ...size, leaseId: session.leaseId };
        }),
      );
    }),
    frame: Effect.fn("RemoteDesktop.frame")(function* (owner, leaseId) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const session = yield* requireLease(owner, leaseId);
          const now = yield* Clock.currentTimeMillis;
          if (now < session.nextFrame) yield* Effect.sleep(session.nextFrame - now);
          yield* requireLease(owner, leaseId);
          session.nextFrame = (yield* Clock.currentTimeMillis) + 250;
          const frame = yield* host.frame.pipe(Effect.onError(() => clear()));
          yield* requireLease(owner, leaseId);
          session.expires = (yield* Clock.currentTimeMillis) + 10_000;
          return frame;
        }),
      );
    }),
    control: Effect.fn("RemoteDesktop.control")(function* (owner, input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const session = yield* requireLease(owner, input.leaseId);
          if (input.sequence <= session.sequence)
            return yield* new RemoteDesktopError({ reason: "sequence" });
          session.sequence = input.sequence;
          yield* host.input(input.events).pipe(Effect.onError(() => clear()));
          yield* requireLease(owner, input.leaseId);
          session.expires = (yield* Clock.currentTimeMillis) + 10_000;
        }),
      );
    }),
    stop: Effect.fn("RemoteDesktop.stop")(function* (owner, leaseId) {
      if (!active) return;
      yield* requireLease(owner, leaseId);
      yield* clear();
    }),
    disconnect: Effect.fn("RemoteDesktop.disconnect")(function* (owner) {
      if (active?.owner === owner) yield* clear();
    }),
  });
});
export const layer = Layer.effect(RemoteDesktop, make);
