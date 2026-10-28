import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  createRemoteDesktopViewer,
  remoteDesktopPoint,
} from "@t3tools/client-runtime/remoteDesktop/viewer";
import {
  type EnvironmentId,
  type RemoteDesktopFrame,
  type RemoteDesktopInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
  type GestureResponderEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useAppActive } from "../../lib/appState";
import { remoteDesktop } from "../../state/remoteDesktop";
import { useAtomCommand } from "../../state/use-atom-command";

export function RemoteDesktopRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId }>) {
  const navigation = useNavigation();
  const foreground = useAppActive();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const environmentId = route.params.environmentId;
  const allowed = useAtomValue(remoteDesktop.start.permissionAtom(environmentId));
  const [connecting, setConnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const start = useAtomCommand(remoteDesktop.start, { reportFailure: false });
  const frame = useAtomCommand(remoteDesktop.frame, { reportFailure: false });
  const control = useAtomCommand(remoteDesktop.control, { reportFailure: false });
  const stop = useAtomCommand(remoteDesktop.stop, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaving the foreground retires the user's connection intent so returning never silently retakes control
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- a revoked OS/navigation/permission lifecycle must clear the explicit user intent to connect
    if (!focused || !foreground || !allowed) setConnecting(false);
  }, [focused, foreground, allowed]);
  const active = connecting && focused && foreground && allowed;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="flex-row items-center justify-between gap-2 p-3">
        <Button label="Close" onPress={() => navigation.goBack()} />
        <AppText className="text-base font-t3-medium">Remote desktop</AppText>
        <Button
          label="Stop"
          tone="danger"
          disabled={!active}
          onPress={() => setConnecting(false)}
        />
      </View>
      {active ? (
        <RemoteDesktopView
          key={`${environmentId}:${attempt}`}
          api={{
            start: async () => {
              const result = await start({ environmentId, input: {} });
              if (result._tag === "Failure") throw Cause.squash(result.cause);
              return result.value;
            },
            frame: async (leaseId) => {
              const result = await frame({ environmentId, input: { leaseId } });
              if (result._tag === "Failure") throw Cause.squash(result.cause);
              return result.value;
            },
            control: async (input) => {
              const result = await control({ environmentId, input });
              if (result._tag === "Failure") throw Cause.squash(result.cause);
            },
            stop: async (leaseId) => {
              await stop({ environmentId, input: { leaseId } });
            },
          }}
          onError={(error) => {
            setError(
              error instanceof Error
                ? error.message
                : "Remote desktop failed. Update this host to the fork and check its permissions.",
            );
            setConnecting(false);
          }}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <AppText className="text-center text-foreground-muted">
            View and control this Mac's main display. The Mac must have remote desktop enabled, with
            Screen Recording and Accessibility permissions.
          </AppText>
          <AppText className="text-center text-foreground-muted">
            Compatibility mode · up to 4 frames per second. Leaving this screen stops control.
          </AppText>
          {error ? <AppText className="text-center text-danger-foreground">{error}</AppText> : null}
          {!allowed ? (
            <AppText className="text-center text-foreground-muted">
              This connection needs Terminal operate permission.
            </AppText>
          ) : null}
          <Button
            label="Connect to Mac"
            tone="primary"
            disabled={!allowed || !focused || !foreground}
            onPress={() => {
              setError(null);
              setAttempt((n) => n + 1);
              setConnecting(true);
            }}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function RemoteDesktopView({
  api,
  onError,
}: {
  api: Omit<Parameters<typeof createRemoteDesktopViewer>[0], "onFrame" | "onError">;
  onError: (error: unknown) => void;
}) {
  const [image, setImage] = useState<RemoteDesktopFrame | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"left" | "right" | "scroll">("left");
  const viewer = useRef<ReturnType<typeof createRemoteDesktopViewer> | null>(null);
  const gesture = useRef<{ x: number; y: number; mode: typeof mode } | null>(null);
  const initial = useRef({ api, onError });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- this mounted foreground viewer owns exactly one native desktop session and releases it on unmount
  useEffect(() => {
    let mounted = true;
    const session = createRemoteDesktopViewer({
      ...initial.current.api,
      onFrame: (frame) => {
        if (mounted) setImage(frame);
      },
      onError: initial.current.onError,
    });
    viewer.current = session;
    return () => {
      mounted = false;
      viewer.current = null;
      void session.stop();
    };
  }, []);
  const send = (event: RemoteDesktopInput) => viewer.current?.input(event);
  const point = (event: GestureResponderEvent) =>
    image
      ? remoteDesktopPoint(
          event.nativeEvent.locationX,
          event.nativeEvent.locationY,
          size.width,
          size.height,
          image.width,
          image.height,
        )
      : null;
  const release = () => {
    gesture.current = null;
    send({ type: "release" });
  };
  return (
    <>
      <View
        className="flex-1"
        onLayout={(event) => {
          release();
          setSize(event.nativeEvent.layout);
        }}
        onStartShouldSetResponder={(event) => point(event) !== null}
        onResponderGrant={(event) => {
          const p = point(event);
          if (!p) return;
          gesture.current = { ...p, mode };
          if (mode !== "scroll") send({ type: "pointer", phase: "down", button: mode, ...p });
        }}
        onResponderMove={(event) => {
          const p = point(event);
          const previous = gesture.current;
          if (!p || !previous) return;
          if (previous.mode === "scroll")
            send({
              type: "scroll",
              x: Math.round((p.x - previous.x) * 500),
              y: Math.round((p.y - previous.y) * 500),
            });
          else send({ type: "pointer", phase: "move", button: previous.mode, ...p });
          gesture.current = { ...p, mode: previous.mode };
        }}
        onResponderRelease={release}
        onResponderTerminate={release}
        onResponderTerminationRequest={() => true}
      >
        {image ? (
          <Image
            pointerEvents="none"
            accessibilityLabel="Mac main display"
            source={{ uri: `data:image/jpeg;base64,${image.jpeg}` }}
            resizeMode="contain"
            style={{ width: "100%", height: "100%" }}
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppText>Connecting to Mac…</AppText>
          </View>
        )}
      </View>
      <ScrollView horizontal className="max-h-16" contentContainerStyle={{ gap: 8, padding: 8 }}>
        {(["left", "right", "scroll"] as const).map((value) => (
          <Button
            key={value}
            label={value === "left" ? "Click / drag" : value === "right" ? "Right click" : "Scroll"}
            tone={mode === value ? "primary" : "secondary"}
            onPress={() => {
              release();
              setMode(value);
            }}
          />
        ))}
        {(["escape", "tab", "return", "backspace", "copy", "paste", "selectAll"] as const).map(
          (key) => (
            <Button
              key={key}
              label={key === "selectAll" ? "Select all" : key}
              onPress={() => send({ type: "key", key })}
            />
          ),
        )}
      </ScrollView>
      <View className="flex-row items-center gap-2 p-3">
        <TextInput
          accessibilityLabel="Text to type on Mac"
          placeholder="Type on Mac…"
          value={text}
          onChangeText={setText}
          maxLength={2000}
          autoCorrect={false}
          autoCapitalize="none"
          className="min-h-12 flex-1 rounded-xl bg-secondary px-3 text-foreground"
        />
        <Button
          label="Send"
          disabled={!image || !text}
          onPress={() => {
            send({ type: "text", text });
            setText("");
          }}
        />
      </View>
    </>
  );
}
