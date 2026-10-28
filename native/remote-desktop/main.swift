import AppKit
import ApplicationServices
import ScreenCaptureKit

// The helper accepts only bounded JSON on inherited stdin; it never listens on a network socket.
@MainActor
final class DesktopHost: NSObject {
    var display: SCDisplay?
    var filter: SCContentFilter?
    var bounds = CGRect.zero
    var heldButton: CGMouseButton?
    var lastActivity = ProcessInfo.processInfo.systemUptime
    var statusItem: NSStatusItem?
    var watchdog: Timer?
    var monitor: Any?

    func reply(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }

    func start() async {
        guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else {
            reply(["error": "permission"])
            exit(1)
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let target = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else { throw HostError.failed }
            display = target
            bounds = CGDisplayBounds(target.displayID)
            filter = SCContentFilter(display: target, excludingWindows: [])
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.title = "T3 Remote •"
            let menu = NSMenu()
            let stop = NSMenuItem(title: "Stop remote desktop", action: #selector(stopLocally), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)
            item.menu = menu
            statusItem = item
            monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
                if event.keyCode == 53 && event.modifierFlags.contains([.control, .option]) {
                    Task { @MainActor in self.stopLocally() }
                }
            }
            watchdog = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                Task { @MainActor in
                    if ProcessInfo.processInfo.systemUptime - self.lastActivity > 10 { self.stopLocally() }
                }
            }
            lastActivity = ProcessInfo.processInfo.systemUptime
            reply(["ready": true, "width": Int(bounds.width), "height": Int(bounds.height)])
        } catch {
            reply(["error": "host"])
            exit(1)
        }
    }

    @objc func stopLocally() {
        releaseInput()
        reply(["error": "expired"])
        exit(0)
    }

    func releaseInput() {
        if let button = heldButton {
            let point = CGEvent(source: nil)?.location ?? .zero
            CGEvent(mouseEventSource: nil, mouseType: button == .left ? .leftMouseUp : .rightMouseUp,
                    mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
        }
        heldButton = nil
    }

    func input(_ event: [String: Any]) throws {
        guard AXIsProcessTrusted(), let type = event["type"] as? String else { throw HostError.permission }
        switch type {
        case "pointer":
            guard let x = event["x"] as? Double, let y = event["y"] as? Double,
                  x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y),
                  let phase = event["phase"] as? String, let buttonName = event["button"] as? String,
                  ["left", "right"].contains(buttonName) else { throw HostError.failed }
            let button: CGMouseButton = buttonName == "right" ? .right : .left
            let point = CGPoint(x: bounds.minX + x * max(0, bounds.width - 1), y: bounds.minY + y * max(0, bounds.height - 1))
            let kind: CGEventType
            switch phase {
            case "down":
                releaseInput()
                heldButton = button
                kind = button == .left ? .leftMouseDown : .rightMouseDown
            case "up":
                guard heldButton == button else { throw HostError.failed }
                heldButton = nil
                kind = button == .left ? .leftMouseUp : .rightMouseUp
            case "move": kind = heldButton == .left ? .leftMouseDragged : heldButton == .right ? .rightMouseDragged : .mouseMoved
            default: throw HostError.failed
            }
            CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
        case "scroll":
            guard let x = event["x"] as? Int32, let y = event["y"] as? Int32,
                  (-1000...1000).contains(x), (-1000...1000).contains(y) else { throw HostError.failed }
            CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: y, wheel2: x, wheel3: 0)?.post(tap: .cghidEventTap)
        case "key":
            let keys: [String: CGKeyCode] = ["return": 36, "escape": 53, "tab": 48, "backspace": 51,
                "left": 123, "right": 124, "up": 126, "down": 125, "copy": 8, "paste": 9, "selectAll": 0]
            guard let name = event["key"] as? String, let code = keys[name] else { throw HostError.failed }
            for down in [true, false] {
                let key = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
                if ["copy", "paste", "selectAll"].contains(name) { key?.flags = .maskCommand }
                key?.post(tap: .cghidEventTap)
            }
        case "text":
            guard let text = event["text"] as? String, text.utf16.count <= 2000 else { throw HostError.failed }
            // Post one Unicode scalar at a time so emoji surrogate pairs are never split.
            for scalar in text.unicodeScalars {
                let units = Array(String(scalar).utf16)
                for down in [true, false] {
                    let key = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                    key?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                    key?.post(tap: .cghidEventTap)
                }
            }
        case "release": releaseInput()
        default: throw HostError.failed
        }
    }

    func command(_ message: [String: Any]) async {
        guard let id = message["id"] as? Int, let action = message["action"] as? String else { stopLocally(); return }
        lastActivity = ProcessInfo.processInfo.systemUptime
        do {
            guard let display, CGDisplayBounds(display.displayID) == bounds,
                  display.displayID == CGMainDisplayID() else { throw HostError.failed }
            switch action {
            case "frame":
                guard CGPreflightScreenCaptureAccess(), let filter else { throw HostError.permission }
                let config = SCStreamConfiguration()
                let scale = min(1, 1280 / max(bounds.width, bounds.height))
                config.width = max(1, Int(bounds.width * scale))
                config.height = max(1, Int(bounds.height * scale))
                config.showsCursor = true
                let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                let bitmap = NSBitmapImageRep(cgImage: cgImage)
                for quality in [0.65, 0.4, 0.2] {
                    if let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]), data.count <= 250_000 {
                        reply(["id": id, "width": cgImage.width, "height": cgImage.height, "jpeg": data.base64EncodedString()])
                        return
                    }
                }
                throw HostError.failed
            case "input":
                guard let events = message["events"] as? [[String: Any]], (1...32).contains(events.count) else { throw HostError.failed }
                for event in events { try input(event) }
                reply(["id": id, "ok": true])
            default: throw HostError.failed
            }
        } catch {
            releaseInput()
            reply(["id": id, "error": error as? HostError == .permission ? "permission" : "host"])
        }
    }
}

enum HostError: Error { case failed, permission }
if CommandLine.arguments.contains("--permissions") {
    _ = CGRequestScreenCaptureAccess()
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    print("Enable Screen Recording and Accessibility for this helper in macOS Settings, then restart the T3 host.")
    exit(0)
}
if CommandLine.arguments.contains("--check") {
    print("{\"screenRecording\":\(CGPreflightScreenCaptureAccess()),\"accessibility\":\(AXIsProcessTrusted())}")
    exit(0)
}
guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else {
    print("{\"error\":\"permission\"}")
    fflush(stdout)
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host = MainActor.assumeIsolated { DesktopHost() }
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { MainActor.assumeIsolated { host.stopLocally() } }
termination.resume()
Task { @MainActor in
    await host.start()
    DispatchQueue.global().async {
        var buffer = Data()
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { Task { @MainActor in host.stopLocally() }; return }
            buffer.append(chunk)
            if buffer.count > 65536 { Task { @MainActor in host.stopLocally() }; return }
            while let end = buffer.firstIndex(of: 10) {
                let line = buffer[..<end]
                guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                    Task { @MainActor in host.stopLocally() }; return
                }
                buffer.removeSubrange(...end)
                Task { @MainActor in await host.command(object) }
            }
        }
    }
}
app.run()
