import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NativeHost from "./NativeHost.ts";

const fixture = Effect.fn("nativeFixture")(function* (mode: "normal" | "permission" | "malformed") {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-helper-" });
  const executable = yield* HostProcess.ExecutablePath;
  const helper = `${directory}/helper.cjs`;
  yield* fs.writeFileString(
    helper,
    `#!${executable}
const mode = ${JSON.stringify(mode)};
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\\n')) >= 0;) {
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (mode === 'malformed') { process.stdout.write('x'.repeat(400001)); continue; }
    emit(command.action === 'frame' ? { id: command.id, width: 10, height: 10, jpeg: 'frame' } : { id: command.id, ok: true });
  }
});
process.stdin.on('end', () => process.exit(0));
emit(mode === 'permission' ? { error: 'permission' } : { ready: true, width: 100, height: 100 });
`,
  );
  yield* fs.chmod(helper, 0o700);
  return yield* NativeHost.NativeHost.pipe(
    Effect.provide(
      NativeHost.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { T3CODE_REMOTE_DESKTOP_HELPER: helper } }),
          ),
        ),
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
});

it.live("bounds native responses and waits for retired helpers before a new session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* fixture("normal");
      expect(yield* host.start).toEqual({ width: 100, height: 100 });
      expect((yield* host.frame).jpeg).toBe("frame");
      yield* host.input([{ type: "release" }]);
      yield* host.stop;
      expect((yield* host.frame.pipe(Effect.flip)).reason).toBe("expired");
      expect(yield* host.start).toEqual({ width: 100, height: 100 });
      expect((yield* host.frame).width).toBe(10);
      const malformed = yield* fixture("malformed");
      yield* malformed.start;
      expect((yield* malformed.frame.pipe(Effect.flip)).reason).toBe("expired");
      expect((yield* malformed.frame.pipe(Effect.flip)).reason).toBe("expired");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("propagates native permission failures without acquiring control", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* fixture("permission");
      expect((yield* host.start.pipe(Effect.flip)).reason).toBe("permission");
      expect(
        (yield* host.input([{ type: "text", text: "ignored" }]).pipe(Effect.flip)).reason,
      ).toBe("expired");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
