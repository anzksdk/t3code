// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns the native helper's inherited stdio and process lifetime.
import {
  RemoteDesktopError,
  RemoteDesktopFrame,
  type RemoteDesktopInput,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

const Ready = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
const decodeReady = Schema.decodeUnknownSync(Ready);
const isRemoteDesktopError = Schema.is(RemoteDesktopError);
const decodeFrame = Schema.decodeUnknownSync(RemoteDesktopFrame);

export class NativeHost extends Context.Service<
  NativeHost,
  {
    readonly available: boolean;
    readonly start: Effect.Effect<{ width: number; height: number }, RemoteDesktopError>;
    readonly frame: Effect.Effect<RemoteDesktopFrame, RemoteDesktopError>;
    readonly input: (
      events: readonly RemoteDesktopInput[],
    ) => Effect.Effect<void, RemoteDesktopError>;
    readonly stop: Effect.Effect<void>;
  }
>()("t3/remoteDesktop/NativeHost") {}

const make = Effect.gen(function* () {
  const helper = yield* Config.String("T3CODE_REMOTE_DESKTOP_HELPER").pipe(Config.withDefault(""));
  const available = (yield* HostProcess.Platform) === "darwin" && NodePath.isAbsolute(helper);
  const homeDirectory = yield* HostProcess.HomeDirectory;
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  let pending: {
    resolve: (value: unknown) => void;
    reject: (error: RemoteDesktopError) => void;
  } | null = null;
  let generation = 0;
  let retired = Promise.resolve();
  let exited = Promise.resolve();
  let requestId = 0;
  let expectedId: number | null = null;
  let buffer = "";

  const stop = () => {
    generation++;
    const old = child;
    if (old) retired = exited;
    child = null;
    const wait = pending;
    pending = null;
    buffer = "";
    wait?.reject(new RemoteDesktopError({ reason: "expired" }));
    old?.stdin.end();
    if (old) {
      old.kill("SIGTERM");
      const deadline = setTimeout(() => old.kill("SIGKILL"), 1000);
      deadline.unref();
      void retired.then(() => clearTimeout(deadline));
    }
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      stop();
      await retired;
    }),
  );

  const request = (launch: boolean, payload?: object) =>
    Effect.tryPromise({
      try: async (signal) => {
        const requestGeneration = generation;
        if (launch) await retired;
        if (signal.aborted || generation !== requestGeneration)
          throw new RemoteDesktopError({ reason: "expired" });
        return new Promise<unknown>((resolve, reject) => {
          if (!available) {
            reject(new RemoteDesktopError({ reason: "unavailable" }));
            return;
          }
          if (pending || (launch && child)) {
            reject(new RemoteDesktopError({ reason: "busy" }));
            return;
          }
          const timer = setTimeout(
            () => {
              pending?.reject(new RemoteDesktopError({ reason: "host" }));
              pending = null;
              stop();
            },
            launch ? 20_000 : 5000,
          );
          const abort = () => stop();
          signal.addEventListener("abort", abort, { once: true });
          const finish = (value: unknown, error?: RemoteDesktopError) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(value);
          };
          pending = {
            resolve: (value) => finish(value),
            reject: (error) => finish(undefined, error),
          };
          expectedId = launch ? null : ++requestId;
          if (launch) {
            const processChild = NodeChildProcess.spawn(helper, [], {
              stdio: "pipe",
              env: { PATH: "/usr/bin:/bin", HOME: homeDirectory },
            });
            child = processChild;
            exited = new Promise<void>((resolve) => processChild.once("close", () => resolve()));
            processChild.stderr.resume();
            processChild.on("error", () => {
              if (child === processChild) stop();
            });
            processChild.on("exit", () => {
              if (child === processChild) stop();
            });
            processChild.stdin.on("error", () => {
              if (child === processChild) stop();
            });
            processChild.stdout.setEncoding("utf8");
            processChild.stdout.on("data", (chunk: string) => {
              if (child !== processChild) return;
              buffer += chunk;
              if (buffer.length > 400_000) {
                stop();
                return;
              }
              for (
                let newline = buffer.indexOf("\n");
                newline !== -1;
                newline = buffer.indexOf("\n")
              ) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                try {
                  const value: unknown = JSON.parse(line);
                  if (typeof value !== "object" || value === null) {
                    stop();
                    return;
                  }
                  if ("error" in value) {
                    const reason =
                      value.error === "permission"
                        ? "permission"
                        : value.error === "expired"
                          ? "expired"
                          : "host";
                    pending?.reject(new RemoteDesktopError({ reason }));
                    pending = null;
                    stop();
                    return;
                  }
                  if (
                    expectedId === null
                      ? !("ready" in value && value.ready === true)
                      : !("id" in value && value.id === expectedId)
                  ) {
                    stop();
                    return;
                  }
                  const wait = pending;
                  pending = null;
                  wait?.resolve(value);
                } catch {
                  stop();
                  return;
                }
              }
            });
          } else if (child) {
            child.stdin.write(`${JSON.stringify({ ...payload, id: expectedId })}\n`);
          } else {
            stop();
          }
        });
      },
      catch: (error) =>
        isRemoteDesktopError(error) ? error : new RemoteDesktopError({ reason: "host" }),
    });

  return NativeHost.of({
    available,
    start: request(true).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decodeReady(value),
          catch: () => new RemoteDesktopError({ reason: "host" }),
        }),
      ),
    ),
    frame: request(false, { action: "frame" }).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decodeFrame(value),
          catch: () => new RemoteDesktopError({ reason: "host" }),
        }),
      ),
    ),
    input: Effect.fn("NativeHost.input")((events: readonly RemoteDesktopInput[]) =>
      request(false, { action: "input", events }).pipe(Effect.asVoid),
    ),
    stop: Effect.promise(async () => {
      stop();
      await retired;
    }),
  });
});
export const layer = Layer.effect(NativeHost, make);
