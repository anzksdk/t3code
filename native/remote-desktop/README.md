# macOS remote desktop helper

This fork's first remote desktop transport uses bounded JPEG frames over T3's authenticated RPC connection (at most 1280 pixels per side and 4 requests/second). It targets iPhone control of an unlocked Mac's main display. This is compatibility mode, not WebRTC video. No audio, clipboard synchronization, login-window control, or unattended unlock is implemented.

## Enable on a development host

Requires macOS 14 or newer and Xcode Command Line Tools. From the repository root:

```sh
node native/remote-desktop/build.mjs
native/remote-desktop/build/t3-remote-desktop --permissions
native/remote-desktop/build/t3-remote-desktop --check
```

In macOS System Settings, grant **Screen & System Audio Recording** and **Accessibility** to `t3-remote-desktop` (and the launching terminal if macOS attributes the request to it). Both checks must be true. Rebuilding or moving the executable can require granting permissions again.

Start a separate fork server with its own state, not the installed T3 application:

```sh
T3CODE_REMOTE_DESKTOP_HELPER="$PWD/native/remote-desktop/build/t3-remote-desktop" \
  vp run dev --no-seed --home-dir "$PWD/.t3/remote-desktop"
```

Use the fork server's normal LAN/Tailscale pairing to connect your fork mobile client. Do not use an unsafe/no-auth server for remote control. The host environment variable is required; the feature stays disabled on other servers and platforms. The helper is an explicit external build artifact and is not automatically included in official desktop/server packages.

To revoke access, stop the viewer or use **T3 Remote • → Stop remote desktop** on the Mac. Control-Option-Escape also stops the helper. Restart the host without `T3CODE_REMOTE_DESKTOP_HELPER` to disable future sessions. Closing the connection or receiving no activity for 10 seconds ends the lease and releases the mouse button. Each connection has its own owner identity, and every operation rechecks Terminal operate permission. Only one viewer can hold control.

## Build your iOS client

Use the existing personal-team build support and your own bundle identifier. For a local development build, set these in your shell before running mobile commands:

```sh
export APP_VARIANT=development
export T3CODE_IOS_PERSONAL_TEAM=1
export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.anzksdk.t3code.remote
export T3CODE_MOBILE_UPDATES_ENABLED=0
```

With full Xcode and an iOS simulator installed, run `vp run mobile:install ios` from the root, then start Metro with `vp run dev:client` in `apps/mobile`. For a physical iPhone, use the generated Xcode project with your signing team and device. The stock App Store app cannot load this feature. Do not publish OTA updates to the upstream EAS project, or assume its build credentials are available to a fork.

Full native builds and physical-device streaming/input need validation with Xcode and macOS permissions; JavaScript tests and Swift compilation do not prove either.

## Protocol and provenance

The executable reads JSON lines on inherited stdin. `frame` returns a JPEG; `input` accepts bounded pointer, scroll, named key, Unicode text, and release events. It does not listen on a port, accept a command string, save images, or read clipboard contents. Coordinates refer to the main display's logical bounds; a display change ends the session. The server serializes native work, rejects replayed sequence numbers, and discards late frames after stop. Native EOF, SIGTERM, local stop, and a watchdog release held input independently of JavaScript.

The compatibility-mode architecture was informed by [Cindy's remote desktop documentation](https://github.com/makecindy/cindy/blob/cdfec9aa5b8cd1bcd6018477b14b20cb0d7168d5/docs/remote-desktop.md). This implementation is new code under this repository's MIT license; it does not vendor Cindy source or depend on Cindy's hosted services.
