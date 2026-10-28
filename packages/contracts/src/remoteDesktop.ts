import * as Schema from "effect/Schema";

const Unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Delta = Schema.Int.check(Schema.isBetween({ minimum: -1000, maximum: 1000 }));
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RemoteDesktopInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pointer"),
    phase: Schema.Literals(["move", "down", "up"]),
    x: Unit,
    y: Unit,
    button: Schema.Literals(["left", "right"]),
  }),
  Schema.Struct({ type: Schema.Literal("scroll"), x: Delta, y: Delta }),
  Schema.Struct({
    type: Schema.Literal("key"),
    key: Schema.Literals([
      "return",
      "escape",
      "tab",
      "backspace",
      "left",
      "right",
      "up",
      "down",
      "copy",
      "paste",
      "selectAll",
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMaxLength(2000)),
  }),
  Schema.Struct({ type: Schema.Literal("release") }),
]);
export type RemoteDesktopInput = typeof RemoteDesktopInput.Type;

export const RemoteDesktopLeaseInput = Schema.Struct({
  leaseId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type RemoteDesktopLeaseInput = typeof RemoteDesktopLeaseInput.Type;
export const RemoteDesktopControlInput = Schema.Struct({
  ...RemoteDesktopLeaseInput.fields,
  sequence: Sequence,
  events: Schema.Array(RemoteDesktopInput).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type RemoteDesktopControlInput = typeof RemoteDesktopControlInput.Type;

export const RemoteDesktopStatus = Schema.Struct({
  available: Schema.Boolean,
  busy: Schema.Boolean,
});
export const RemoteDesktopSession = Schema.Struct({
  leaseId: Schema.String,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type RemoteDesktopSession = typeof RemoteDesktopSession.Type;
export const RemoteDesktopFrame = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1280 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1280 })),
  jpeg: Schema.String.check(Schema.isMaxLength(350000)),
});
export type RemoteDesktopFrame = typeof RemoteDesktopFrame.Type;

export class RemoteDesktopError extends Schema.TaggedError<RemoteDesktopError>()(
  "RemoteDesktopError",
  {
    reason: Schema.Literals(["unavailable", "busy", "expired", "permission", "host", "sequence"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Remote desktop is not enabled on this Mac. Configure the native helper on the host first.";
      case "busy":
        return "Another viewer is controlling this Mac. Stop that session before connecting.";
      case "expired":
        return "Remote desktop disconnected. Connect again to resume.";
      case "permission":
        return "Allow Screen Recording and Accessibility for the remote desktop helper in macOS Settings, then reconnect.";
      case "sequence":
        return "Remote input arrived out of order. Reconnect to continue.";
      case "host":
        return "The Mac remote desktop helper stopped responding. Check its permissions and reconnect.";
    }
  }
}
