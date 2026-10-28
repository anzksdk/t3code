import { createRemoteDesktopAtoms } from "@t3tools/client-runtime/state/remoteDesktop";
import { connectionAtomRuntime } from "../connection/runtime";

export const remoteDesktop = createRemoteDesktopAtoms(connectionAtomRuntime);
