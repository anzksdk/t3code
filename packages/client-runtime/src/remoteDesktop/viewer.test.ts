import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRemoteDesktopViewer, remoteDesktopPoint } from "./viewer.ts";

const session = { leaseId: "lease", width: 1440, height: 900 };
const image = { width: 1280, height: 800, jpeg: "test" };
const api = () => ({
  start: vi.fn(async () => session),
  frame: vi.fn(async () => image),
  control: vi.fn(async () => {}),
  stop: vi.fn(async (_id: string) => {}),
  onFrame: vi.fn(),
  onError: vi.fn(),
});

describe("remote desktop viewer", () => {
  afterEach(() => vi.useRealTimers());
  it("maps the contained image, excluding letterboxing and invalid dimensions", () => {
    expect(remoteDesktopPoint(200, 400, 400, 800, 1440, 900)).toEqual({ x: 0.5, y: 0.5 });
    expect(remoteDesktopPoint(200, 200, 400, 800, 1440, 900)).toBeNull();
    expect(remoteDesktopPoint(200, 400, 0, 800, 1440, 900)).toBeNull();
    expect(remoteDesktopPoint(NaN, 400, 400, 800, 1440, 900)).toBeNull();
  });

  it("coalesces pointer movement while preserving ordered presses and releases", async () => {
    vi.useFakeTimers();
    const fixture = api();
    const pending = Promise.withResolvers<void>();
    fixture.control.mockImplementation(() => pending.promise);
    const viewer = createRemoteDesktopViewer(fixture);
    await viewer.ready;
    viewer.input({ type: "pointer", phase: "down", button: "left", x: 0, y: 0 });
    await vi.advanceTimersByTimeAsync(50);
    viewer.input({ type: "pointer", phase: "move", button: "left", x: 0.1, y: 0.1 });
    viewer.input({ type: "pointer", phase: "move", button: "left", x: 0.9, y: 0.9 });
    viewer.input({ type: "release" });
    expect(fixture.control).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(fixture.control).toHaveBeenLastCalledWith({
      leaseId: "lease",
      sequence: 1,
      events: [
        { type: "pointer", phase: "move", button: "left", x: 0.9, y: 0.9 },
        { type: "release" },
      ],
    });
    await viewer.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.control).toHaveBeenCalledTimes(2);
  });

  it("cleans up a lease acquired after unmount without starting capture", async () => {
    const pending = Promise.withResolvers<typeof session>();
    const fixture = api();
    fixture.start.mockImplementation(() => pending.promise);
    const viewer = createRemoteDesktopViewer(fixture);
    await viewer.stop();
    pending.resolve(session);
    await viewer.ready;
    expect(fixture.frame).not.toHaveBeenCalled();
    expect(fixture.stop).toHaveBeenCalledWith("lease");
  });

  it("discards a late frame and never sends queued input after stop", async () => {
    const pending = Promise.withResolvers<typeof image>();
    const capture = Promise.withResolvers<void>();
    const fixture = api();
    fixture.frame.mockImplementation(() => {
      capture.resolve();
      return pending.promise;
    });
    const viewer = createRemoteDesktopViewer(fixture);
    await capture.promise;
    await viewer.stop();
    pending.resolve(image);
    await viewer.ready;
    viewer.input({ type: "text", text: "must not send" });
    expect(fixture.onFrame.mock.calls.every(([value]) => value === null)).toBe(true);
    expect(fixture.control).not.toHaveBeenCalled();
  });

  it("clears the screen and ends control on transport failure", async () => {
    const failed = Promise.withResolvers<void>();
    const fixture = api();
    fixture.frame.mockRejectedValue(new Error("offline"));
    fixture.onError.mockImplementation(() => failed.resolve());
    const viewer = createRemoteDesktopViewer(fixture);
    await failed.promise;
    expect(fixture.onFrame).toHaveBeenLastCalledWith(null);
    expect(fixture.stop).toHaveBeenCalledWith("lease");
    viewer.input({ type: "key", key: "return" });
    expect(fixture.control).not.toHaveBeenCalled();
    await viewer.stop();
  });
});
