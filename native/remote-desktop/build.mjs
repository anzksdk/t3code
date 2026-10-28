import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

// oxlint-disable-next-line t3code/no-global-process-runtime -- this standalone native build must run before workspace dependencies are installed
if (NodeOS.platform() !== "darwin") throw new Error("Build this helper on macOS 14 or later.");
const output = NodePath.resolve(import.meta.dirname, "build");
NodeFS.mkdirSync(output, { recursive: true });
const binary = NodePath.resolve(output, "t3-remote-desktop");
const result = NodeChildProcess.spawnSync("xcrun", ["swiftc", "-parse-as-library", "-help"], {
  stdio: "ignore",
});
if (result.status !== 0) throw new Error("Install Xcode Command Line Tools first.");
const build = NodeChildProcess.spawnSync(
  "xcrun",
  [
    "swiftc",
    "-swift-version",
    "5",
    "-O",
    "-target",
    // oxlint-disable-next-line t3code/no-global-process-runtime -- the standalone build targets the compiler host architecture
    `${NodeOS.arch() === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
    NodePath.resolve(import.meta.dirname, "main.swift"),
    "-o",
    binary,
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);
console.log(binary);
