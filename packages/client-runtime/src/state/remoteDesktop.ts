import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createRemoteDesktopAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    start: createEnvironmentRpcCommand(runtime, {
      label: "remote-desktop:start",
      tag: WS_METHODS.remoteDesktopStart,
    }),
    frame: createEnvironmentRpcCommand(runtime, {
      label: "remote-desktop:frame",
      tag: WS_METHODS.remoteDesktopFrame,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "remote-desktop:control",
      tag: WS_METHODS.remoteDesktopControl,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "remote-desktop:stop",
      tag: WS_METHODS.remoteDesktopStop,
    }),
  };
}
