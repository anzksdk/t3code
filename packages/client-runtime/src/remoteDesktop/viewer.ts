// @effect-diagnostics globalTimers:off - This imperative viewer is owned and disposed by the React Native screen.
import type {
  RemoteDesktopControlInput,
  RemoteDesktopFrame,
  RemoteDesktopInput,
  RemoteDesktopSession,
} from "@t3tools/contracts";

export function remoteDesktopPoint(
  x: number,
  y: number,
  viewWidth: number,
  viewHeight: number,
  imageWidth: number,
  imageHeight: number,
) {
  if (
    ![x, y, viewWidth, viewHeight, imageWidth, imageHeight].every(Number.isFinite) ||
    Math.min(viewWidth, viewHeight, imageWidth, imageHeight) <= 0
  )
    return null;
  const scale = Math.min(viewWidth / imageWidth, viewHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  const left = (viewWidth - width) / 2;
  const top = (viewHeight - height) / 2;
  if (x < left || y < top || x > left + width || y > top + height) return null;
  return { x: (x - left) / width, y: (y - top) / height };
}

export function createRemoteDesktopViewer(api: {
  start: () => Promise<RemoteDesktopSession>;
  frame: (leaseId: string) => Promise<RemoteDesktopFrame>;
  control: (input: RemoteDesktopControlInput) => Promise<void>;
  stop: (leaseId: string) => Promise<void>;
  onFrame: (frame: RemoteDesktopFrame | null) => void;
  onError: (error: unknown) => void;
}) {
  let live = true;
  let session: RemoteDesktopSession | null = null;
  let sequence = 0;
  let queue: RemoteDesktopInput[] = [];
  let sending = false;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    live = false;
    queue = [];
    clearTimeout(frameTimer);
    clearTimeout(inputTimer);
    api.onFrame(null);
    const lease = session;
    session = null;
    if (lease) return api.stop(lease.leaseId).catch(() => {});
    return Promise.resolve();
  };
  const fail = (error: unknown) => {
    if (!live) return;
    void stop();
    api.onError(error);
  };
  const frame = async () => {
    if (!live || !session) return;
    try {
      const image = await api.frame(session.leaseId);
      if (!live) return;
      api.onFrame(image);
      frameTimer = setTimeout(() => void frame(), 250);
    } catch (error) {
      fail(error);
    }
  };
  const flush = async () => {
    if (!live || !session || sending || queue.length === 0) return;
    sending = true;
    const events = queue;
    queue = [];
    try {
      await api.control({ leaseId: session.leaseId, sequence: sequence++, events });
    } catch (error) {
      fail(error);
    }
    sending = false;
    if (live && queue.length > 0)
      inputTimer = setTimeout(() => {
        inputTimer = undefined;
        void flush();
      }, 50);
  };
  const ready = api
    .start()
    .then(async (lease) => {
      if (!live) {
        await api.stop(lease.leaseId).catch(() => {});
        return;
      }
      session = lease;
      void frame();
    })
    .catch(fail);
  return {
    ready,
    stop,
    input(event: RemoteDesktopInput) {
      if (!live || !session) return;
      const last = queue.at(-1);
      if (
        event.type === "pointer" &&
        event.phase === "move" &&
        last?.type === "pointer" &&
        last.phase === "move"
      )
        queue[queue.length - 1] = event;
      else queue.push(event);
      if (queue.length > 32) {
        fail(new Error("Remote input could not keep up. Reconnect to continue."));
        return;
      }
      if (!sending && inputTimer === undefined)
        inputTimer = setTimeout(() => {
          inputTimer = undefined;
          void flush();
        }, 50);
    },
  };
}
