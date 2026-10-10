import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../ConfirmDialog";
import HotkeyCaptureInput from "../../HotkeyCaptureInput";
import {
  AdvDropdown,
  CardDivider,
  InfoIcon,
} from "../advanced/sections/shared";
import MacroCodeEditor from "./MacroCodeEditor";
import MacroVisualization from "./MacroVisualization";
import MacroRunHotkeyInput from "./MacroRunHotkeyInput";
import type { Settings } from "../../../store";
import type {
  MacroProfile,
  MacroTarget,
  MacroValidation,
  RecorderEvent,
} from "../../../macro/types";
import "./MacroPanel.css";

type View = "editor" | "record" | "history";
const TIMELINE_PAGE_SIZE = 200;
type RuntimeState =
  | "Idle"
  | "Recording"
  | "Validating"
  | "Running"
  | "Paused"
  | "Completed"
  | "Cancelled"
  | "Error";

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  onDirtyChange: (dirty: boolean) => void;
  running: boolean;
  paused: boolean;
  stopReason: string | null;
  statusError: string | null;
  primaryHotkey: string;
  onRun: (
    source: string,
    targetHwnd: number | null,
    targetPid: number | null,
  ) => Promise<void>;
}

function makeId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    "macro-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8)
  );
}

function directive(
  source: string,
  kind: "target" | "mode",
  replacement: string,
) {
  const lines = source.split(/\r?\n/);
  const pattern = new RegExp("^" + kind + "\\b", "i");
  const index = lines.findIndex((line) => pattern.test(line.trimStart()));
  if (index >= 0) lines[index] = replacement;
  else lines.unshift(replacement);
  return lines.join("\n");
}

function targetDirective(target: MacroTarget) {
  const parts = ["target", "process=" + JSON.stringify(target.processName)];
  if (target.title.trim())
    parts.push("title_contains=" + JSON.stringify(target.title));
  if (target.className.trim())
    parts.push("class=" + JSON.stringify(target.className));
  return parts.join(" ");
}

function targetOptionValue(target: Pick<MacroTarget, "hwnd" | "pid">) {
  return `${target.hwnd}:${target.pid}`;
}

const HOTKEY_TOKEN_ALIASES: Record<string, string> = {
  control: "ctrl",
  option: "alt",
  command: "super",
  cmd: "super",
  meta: "super",
  win: "super",
  lctrl: "leftctrl",
  ctrlleft: "leftctrl",
  rctrl: "rightctrl",
  ctrlright: "rightctrl",
  lalt: "leftalt",
  altleft: "leftalt",
  ralt: "rightalt",
  altright: "rightalt",
  altgr: "rightalt",
  lshift: "leftshift",
  shiftleft: "leftshift",
  rshift: "rightshift",
  shiftright: "rightshift",
  lwin: "leftsuper",
  leftwin: "leftsuper",
  superleft: "leftsuper",
  rwin: "rightsuper",
  rightwin: "rightsuper",
  superright: "rightsuper",
};

function hotkeyIdentity(value: string) {
  return value
    .split("+")
    .map((token) => {
      const normalized = token.trim().toLowerCase();
      return HOTKEY_TOKEN_ALIASES[normalized] ?? normalized;
    })
    .filter(Boolean)
    .sort()
    .join("+");
}

function targetWindowSignature(targets: MacroTarget[]) {
  return targets
    .map((target) =>
      [
        targetOptionValue(target),
        target.processName,
        target.title,
        target.className,
        target.visible,
        target.minimized,
        target.clientWidth,
        target.clientHeight,
        target.dpi,
      ].join("\u0000"),
    )
    .sort()
    .join("\u0001");
}

function removeDirective(source: string, kind: "target" | "mode") {
  const pattern = new RegExp("^" + kind + "\\b", "i");
  return source
    .split(/\r?\n/)
    .filter((line) => !pattern.test(line.trimStart()))
    .join("\n");
}

function updateProfile(
  settings: Settings,
  update: Props["update"],
  profile: MacroProfile,
  patch: Partial<MacroProfile>,
) {
  const profiles = settings.macroProfiles.map((item) =>
    item.id === profile.id ? { ...item, ...patch } : item,
  );
  update({ macroProfiles: profiles });
}

function describeEvent(event: RecorderEvent) {
  switch (event.kind) {
    case "move":
      return "Move to " + event.x + ", " + event.y;
    case "mouseDown":
      return (
        "Press " +
        event.button +
        " mouse button" +
        (event.x !== undefined && event.y !== undefined
          ? " at " + event.x + ", " + event.y
          : "")
      );
    case "mouseUp":
      return (
        "Release " +
        event.button +
        " mouse button" +
        (event.x !== undefined && event.y !== undefined
          ? " at " + event.x + ", " + event.y
          : "")
      );
    case "scroll":
      return "Scroll " + event.delta + " at " + event.x + ", " + event.y;
    case "keyDown":
      return "Press key " + event.key;
    case "keyUp":
      return "Release key " + event.key;
    default:
      return event.kind;
  }
}

export default function MacroPanel({
  settings,
  update,
  onDirtyChange,
  running,
  paused,
  stopReason,
  statusError,
  primaryHotkey,
  onRun,
}: Props) {
  const activeProfile =
    settings.macroProfiles.find(
      (profile) => profile.id === settings.activeMacroId,
    ) ?? settings.macroProfiles[0];
  const [view, setView] = useState<View>("editor");
  const [draftId, setDraftId] = useState(activeProfile?.id ?? "");
  const [draft, setDraft] = useState(activeProfile?.source ?? "");
  const [draftName, setDraftName] = useState(activeProfile?.name ?? "");
  const [validation, setValidation] = useState<MacroValidation | null>(null);
  const [validatedSource, setValidatedSource] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>("Idle");
  const [activeStep, setActiveStep] = useState(0);
  const [logEntries, setLogEntries] = useState<string[]>([]);
  const [targets, setTargets] = useState<MacroTarget[]>([]);
  const [targetCapabilities, setTargetCapabilities] = useState<string>("");
  const refreshingTargetsRef = useRef(false);
  const [recordCursorMovement, setRecordCursorMovement] = useState(
    settings.recordCursorMovement,
  );
  const [recordingSessionId, setRecordingSessionId] = useState<string | null>(
    null,
  );
  const [recordedEvents, setRecordedEvents] = useState<RecorderEvent[]>([]);
  const [recorderNotice, setRecorderNotice] = useState("");
  const [recordingCountdownSeconds, setRecordingCountdownSeconds] = useState(3);
  const [recordingCountdown, setRecordingCountdown] = useState<number | null>(
    null,
  );
  const [preparingRecording, setPreparingRecording] = useState(false);
  const recordedEventsRef = useRef<RecorderEvent[]>([]);
  const recordedEventsRenderTimerRef = useRef<number | null>(null);
  const recordingCountdownTimerRef = useRef<number | null>(null);
  const startingCountdownRef = useRef(false);
  const cancelRecordingCountdownRef = useRef<() => void>(() => {});
  const targetProbeRequestRef = useRef(0);
  const [timelinePage, setTimelinePage] = useState<number | null>(null);
  const [recordingFinished, setRecordingFinished] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    action: () => void;
  } | null>(null);
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<
    number | null
  >(null);
  const [pickCoordinateActive, setPickCoordinateActive] = useState(false);
  const macroContentRef = useRef<HTMLDivElement>(null);
  const macroPanelMountedRef = useRef(true);
  const handleDraftChange = useCallback((value: string) => setDraft(value), []);
  const clearTargetCapabilities = useCallback(() => {
    targetProbeRequestRef.current += 1;
    setTargetCapabilities("");
  }, []);
  const lastStoppedSessionLoggedRef = useRef<string | null>(null);
  const closedRecorderSessionRef = useRef<string | null>(null);
  const macroDraftRef = useRef({
    source: draft,
    name: draftName,
    profileId: activeProfile?.id,
    target: activeProfile?.target,
  });
  macroDraftRef.current = {
    source: draft,
    name: draftName,
    profileId: activeProfile?.id,
    target: activeProfile?.target,
  };
  const macroProfileId = activeProfile?.id;
  const macroTargetHwnd = activeProfile?.target?.hwnd ?? null;
  const macroTargetPid = activeProfile?.target?.pid ?? null;
  const syncMacroContext = useCallback(
    () =>
      invoke("macro_set_context", {
        active: settings.macroHotkeyOverride,
        source: macroDraftRef.current.source,
        selectedHwnd: macroTargetHwnd,
        selectedPid: macroTargetPid,
      }),
    [macroTargetHwnd, macroTargetPid, settings.macroHotkeyOverride],
  );
  const startingMacroRef = useRef(false);
  const startingRecordingRef = useRef(false);
  const runningRef = useRef(running);
  runningRef.current = running;
  const pendingRecordingStartRef = useRef<Promise<string> | null>(null);
  const recordingSessionRef = useRef<string | null>(recordingSessionId);
  recordingSessionRef.current = recordingSessionId;
  const recordingContextRef = useRef({
    settings,
    update,
    profile: activeProfile,
  });
  recordingContextRef.current = { settings, update, profile: activeProfile };
  const timelinePageCount = Math.max(
    1,
    Math.ceil(recordedEvents.length / TIMELINE_PAGE_SIZE),
  );
  const currentTimelinePage = Math.min(
    timelinePage ?? timelinePageCount - 1,
    timelinePageCount - 1,
  );
  const timelineStart = currentTimelinePage * TIMELINE_PAGE_SIZE;
  const visibleTimelineEvents = recordedEvents.slice(
    timelineStart,
    timelineStart + TIMELINE_PAGE_SIZE,
  );
  const isDirty =
    Boolean(activeProfile) &&
    (draftId !== activeProfile.id ||
      draft !== activeProfile.source ||
      draftName !== activeProfile.name);
  const recorderNoticeIsError = /could not|failed|conflict/i.test(
    recorderNotice,
  );
  const editorErrors = useMemo(
    () =>
      validatedSource === draft && !validating
        ? (validation?.errors ?? [])
        : [],
    [draft, validatedSource, validating, validation],
  );
  const hasCurrentValidation = validatedSource === draft && !validating;
  const validationPending = Boolean(draft.trim()) && !hasCurrentValidation;
  const runDiscardableAction = (action: () => void) => {
    if (!isDirty) {
      action();
      return;
    }
    setConfirmation({
      title: "Discard unsaved changes?",
      message: "Your current macro edits will be discarded before continuing.",
      confirmLabel: "Discard changes",
      action,
    });
  };
  const cancelConfirmation = useCallback(() => setConfirmation(null), []);
  const confirmPendingAction = useCallback(() => {
    if (!confirmation) return;
    const action = confirmation.action;
    setConfirmation(null);
    action();
  }, [confirmation]);

  useEffect(() => {
    macroPanelMountedRef.current = true;
    return () => {
      macroPanelMountedRef.current = false;
      targetProbeRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    onDirtyChange(isDirty);
    return () => onDirtyChange(false);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!activeProfile || draftId === activeProfile.id) return;
    clearTargetCapabilities();
    setDraftId(activeProfile.id);
    setDraft(activeProfile.source);
    setDraftName(activeProfile.name);
    setValidation(null);
    setValidatedSource(null);
  }, [activeProfile, clearTargetCapabilities, draftId]);

  useEffect(() => {
    if (!draft.trim()) {
      setValidation(null);
      setValidatedSource(null);
      setValidating(false);
      return;
    }
    let cancelled = false;
    setValidatedSource(null);
    const timer = window.setTimeout(() => {
      setValidating(true);
      invoke<MacroValidation>("macro_validate", { source: draft })
        .then((result) => {
          if (cancelled) return;
          setValidation(result);
          setValidatedSource(draft);
        })
        .catch((err) => {
          if (cancelled) return;
          setValidation({
            ok: false,
            statementCount: 0,
            errors: [
              {
                line: 1,
                column: 1,
                message: "Validation is unavailable: " + String(err),
              },
            ],
          });
          setValidatedSource(draft);
        })
        .finally(() => {
          if (!cancelled) setValidating(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft]);

  useEffect(() => {
    if (!recordingSessionId) {
      setRecordCursorMovement(settings.recordCursorMovement);
    }
  }, [settings.recordCursorMovement, recordingSessionId]);

  useEffect(() => {
    void syncMacroContext().catch((err) =>
      console.error("Macro hotkey context could not sync:", err),
    );
  }, [macroProfileId, syncMacroContext]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void syncMacroContext().catch((err) =>
        console.error("Macro script could not sync for its hotkey:", err),
      );
    }, 120);
    return () => window.clearTimeout(timer);
  }, [draft, syncMacroContext]);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const listenerRegistrations: Array<Promise<void>> = [];
    const addListener = <T,>(
      eventName: string,
      listener: (payload: T) => void,
    ) => {
      const registration = listen<T>(eventName, (event) =>
        listener(event.payload),
      ).then((unlisten) => {
        if (disposed) unlisten();
        else cleanups.push(unlisten);
      });
      listenerRegistrations.push(registration);
    };
    void addListener<{ state: RuntimeState; steps?: number }>(
      "macro:state",
      (event) => {
        setRuntimeState(event.state);
        if (event.steps !== undefined) setActiveStep(event.steps);
      },
    );
    void addListener<{ step: number; command: string }>(
      "macro:step",
      (event) => {
        setActiveStep(event.step);
        setLogEntries((current) =>
          ["Step " + event.step + ": " + event.command, ...current].slice(
            0,
            100,
          ),
        );
      },
    );
    void addListener<{ message: string }>("macro:error", (event) => {
      setRuntimeState("Error");
      setLogEntries((current) =>
        ["Error: " + event.message, ...current].slice(0, 100),
      );
    });
    void addListener<{ sessionId: string; events: RecorderEvent[] }>(
      "recorder:events",
      (batch) => {
        if (closedRecorderSessionRef.current === batch.sessionId) return;
        if (lastStoppedSessionLoggedRef.current === batch.sessionId) return;
        if (recordingSessionRef.current === null) {
          // The worker may flush its first batch before the state event arrives.
          if (recordedEventsRenderTimerRef.current !== null) {
            window.clearTimeout(recordedEventsRenderTimerRef.current);
            recordedEventsRenderTimerRef.current = null;
          }
          recordingSessionRef.current = batch.sessionId;
          recordedEventsRef.current = [];
          lastStoppedSessionLoggedRef.current = null;
          setRecordingSessionId(batch.sessionId);
          setRecordedEvents([]);
          setTimelinePage(null);
          setRecordingFinished(false);
          setSelectedTimelineIndex(null);
          setRuntimeState("Recording");
        }
        if (recordingSessionRef.current !== batch.sessionId) return;
        recordedEventsRef.current.push(...batch.events);
        if (recordedEventsRenderTimerRef.current === null) {
          recordedEventsRenderTimerRef.current = window.setTimeout(() => {
            recordedEventsRenderTimerRef.current = null;
            setRecordedEvents([...recordedEventsRef.current]);
          }, 100);
        }
      },
    );
    void addListener<string>("recorder:warning", (message) => {
      setRecorderNotice(message);
      setLogEntries((current) => [message, ...current].slice(0, 100));
    });
    void addListener<{
      state: string;
      sessionId?: string;
      recordCursorMovement?: boolean;
    }>("recorder:state", (event) => {
      if (event.state === "Recording") {
        if (
          event.sessionId &&
          closedRecorderSessionRef.current === event.sessionId
        ) {
          return;
        }
        setRecorderNotice("");
        cancelRecordingCountdownRef.current();
        const sameSession =
          Boolean(event.sessionId) &&
          recordingSessionRef.current === event.sessionId;
        recordingSessionRef.current = event.sessionId ?? "active";
        if (!sameSession) {
          closedRecorderSessionRef.current = null;
          if (recordedEventsRenderTimerRef.current !== null) {
            window.clearTimeout(recordedEventsRenderTimerRef.current);
            recordedEventsRenderTimerRef.current = null;
          }
          recordedEventsRef.current = [];
          lastStoppedSessionLoggedRef.current = null;
          setRecordedEvents([]);
        }
        setRecordingSessionId(event.sessionId ?? null);
        setRuntimeState("Recording");
        setTimelinePage(null);
        setRecordingFinished(false);
        setSelectedTimelineIndex(null);
      } else if (event.state === "Stopped") {
        if (event.sessionId) closedRecorderSessionRef.current = event.sessionId;
        if (
          event.sessionId &&
          recordingSessionRef.current &&
          recordingSessionRef.current !== event.sessionId
        ) {
          return;
        }
        recordingSessionRef.current = null;
        setRecordingSessionId(null);
        setRuntimeState((current) =>
          current === "Recording" ? "Idle" : current,
        );
      }
    });
    void addListener<{
      sessionId: string;
      source: string;
      eventCount: number;
      events: RecorderEvent[];
    }>("recorder:stopped", (event) => {
      if (
        recordingSessionRef.current &&
        recordingSessionRef.current !== event.sessionId
      ) {
        return;
      }
      if (
        recordingSessionRef.current === null &&
        lastStoppedSessionLoggedRef.current === event.sessionId
      ) {
        return;
      }
      const shouldLogResult =
        lastStoppedSessionLoggedRef.current !== event.sessionId;
      lastStoppedSessionLoggedRef.current = event.sessionId;
      closedRecorderSessionRef.current = event.sessionId;
      recordingSessionRef.current = null;
      recordedEventsRef.current = event.events;
      if (recordedEventsRenderTimerRef.current !== null) {
        window.clearTimeout(recordedEventsRenderTimerRef.current);
        recordedEventsRenderTimerRef.current = null;
      }
      setRecordingSessionId(null);
      setDraft(event.source);
      setRecordedEvents(event.events);
      setTimelinePage(null);
      setValidation(null);
      setRuntimeState("Idle");
      setRecordingFinished(true);
      setSelectedTimelineIndex(null);
      if (shouldLogResult) {
        setLogEntries((current) =>
          [
            "Recording captured " +
              event.eventCount +
              " events. Review before replay.",
            ...current,
          ].slice(0, 100),
        );
      }
    });
    void addListener<string>("recorder:error", (message) => {
      setRecorderNotice(message);
      setRuntimeState("Error");
      setLogEntries((current) => [message, ...current].slice(0, 100));
    });
    // Enable the global shortcut only once the panel can receive its events.
    void Promise.all(listenerRegistrations)
      .then(() => {
        if (disposed) return;
        return invoke("set_macro_recorder_panel_active", { active: true });
      })
      .catch((err) => {
        if (disposed) return;
        console.error("Macro recorder listeners could not be registered:", err);
        setRecorderNotice(
          "Macro recording controls could not initialize. Reopen this panel and try again.",
        );
      });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      void invoke("set_macro_recorder_panel_active", { active: false }).catch(
        (err) =>
          console.error("Macro recorder panel state could not sync:", err),
      );
      if (recordedEventsRenderTimerRef.current !== null) {
        window.clearTimeout(recordedEventsRenderTimerRef.current);
        recordedEventsRenderTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (running && runtimeState !== "Recording")
      setRuntimeState(paused ? "Paused" : "Running");
    if (!running && (runtimeState === "Running" || runtimeState === "Paused")) {
      setRuntimeState(
        stopReason?.toLowerCase().includes("complete")
          ? "Completed"
          : "Cancelled",
      );
    }
  }, [running, paused, stopReason, runtimeState]);

  useEffect(
    () => () => {
      const sessionId = recordingSessionRef.current;
      const pendingStart = pendingRecordingStartRef.current;
      const stopAndPersist = (id: string) =>
        invoke<{ source: string }>("recorder_stop", { sessionId: id })
          .then(({ source }) => {
            const {
              settings: latestSettings,
              update: latestUpdate,
              profile,
            } = recordingContextRef.current;
            if (!profile) return;
            updateProfile(latestSettings, latestUpdate, profile, {
              source,
              updatedAt: new Date().toISOString(),
            });
          })
          .catch(() => {});
      if (sessionId) void stopAndPersist(sessionId);
      else if (pendingStart)
        void pendingStart.then(stopAndPersist).catch(() => {});
    },
    [],
  );

  const saveDraft = useCallback(
    (source = draft, name = draftName) => {
      if (!activeProfile) return;
      updateProfile(settings, update, activeProfile, {
        name: name.trim().slice(0, 80) || "New Macro",
        source,
        syntaxVersion: 1,
        updatedAt: new Date().toISOString(),
      });
      update({ activeMacroId: activeProfile.id });
      setDraftId(activeProfile.id);
      setDraft(source);
      setDraftName(name.trim().slice(0, 80) || "New Macro");
    },
    [activeProfile, draft, draftName, settings, update],
  );

  const runValidation = useCallback(async () => {
    setValidating(true);
    setRuntimeState("Validating");
    try {
      const result = await invoke<MacroValidation>("macro_validate", {
        source: draft,
      });
      setValidation(result);
      setValidatedSource(draft);
      setRuntimeState(result.ok ? "Idle" : "Error");
      return result;
    } catch (err) {
      setRuntimeState("Error");
      setValidation({
        ok: false,
        statementCount: 0,
        errors: [{ line: 1, column: 1, message: String(err) }],
      });
      setValidatedSource(draft);
      return null;
    } finally {
      setValidating(false);
    }
  }, [draft]);

  const selectProfile = (id: string) => {
    if (id === activeProfile?.id) return;
    const profile = settings.macroProfiles.find((item) => item.id === id);
    if (!profile) return;
    runDiscardableAction(() => {
      update({ activeMacroId: id });
      setDraftId(profile.id);
      setDraft(profile.source);
      setDraftName(profile.name);
      setValidation(null);
      setValidatedSource(null);
      clearTargetCapabilities();
    });
  };

  const createMacro = () => {
    runDiscardableAction(() => {
      const now = new Date().toISOString();
      const profile: MacroProfile = {
        id: makeId(),
        name: "New Macro",
        source: "mode foreground\n",
        syntaxVersion: 1,
        target: null,
        createdAt: now,
        updatedAt: now,
      };
      update({
        macroProfiles: [...settings.macroProfiles, profile],
        activeMacroId: profile.id,
      });
      setDraftId(profile.id);
      setDraft(profile.source);
      setDraftName(profile.name);
      setValidation(null);
      clearTargetCapabilities();
    });
  };

  const duplicateMacro = () => {
    if (!activeProfile) return;
    const now = new Date().toISOString();
    const copy: MacroProfile = {
      ...activeProfile,
      id: makeId(),
      name: `${(draftName.trim() || activeProfile.name).slice(0, 75)} copy`,
      source: draft,
      createdAt: now,
      updatedAt: now,
    };
    update({
      macroProfiles: [...settings.macroProfiles, copy],
      activeMacroId: copy.id,
    });
    setDraftId(copy.id);
    setDraft(copy.source);
    setDraftName(copy.name);
    clearTargetCapabilities();
  };

  const deleteMacro = () => {
    if (!activeProfile) return;
    const profileId = activeProfile.id;
    setConfirmation({
      title: "Delete macro?",
      message: `Delete “${activeProfile.name}”? This action cannot be undone.${isDirty ? " Unsaved edits to this macro will also be discarded." : ""}`,
      confirmLabel: "Delete",
      action: () => {
        const profiles = settings.macroProfiles.filter(
          (profile) => profile.id !== profileId,
        );
        const next = profiles[0];
        update({ macroProfiles: profiles, activeMacroId: next?.id ?? null });
        setDraftId(next?.id ?? "");
        setDraft(next?.source ?? "");
        setDraftName(next?.name ?? "");
        clearTargetCapabilities();
      },
    });
  };

  const importMacro = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Blur Macro Script", extensions: ["bms"] }],
      });
      if (typeof selected !== "string") return;
      const source = await readTextFile(selected);
      runDiscardableAction(() => {
        const now = new Date().toISOString();
        const profile: MacroProfile = {
          id: makeId(),
          name:
            selected
              .split(/[\\/]/)
              .pop()
              ?.replace(/\.bms$/i, "") || "Imported Macro",
          source,
          syntaxVersion: 1,
          target: null,
          createdAt: now,
          updatedAt: now,
        };
        update({
          macroProfiles: [...settings.macroProfiles, profile],
          activeMacroId: profile.id,
        });
        setDraftId(profile.id);
        setDraft(source);
        setDraftName(profile.name);
        setValidation(null);
        clearTargetCapabilities();
        setView("editor");
      });
    } catch (err) {
      setRuntimeState("Error");
      setLogEntries((current) =>
        ["Import failed: " + String(err), ...current].slice(0, 100),
      );
    }
  };

  const exportMacro = async () => {
    if (!activeProfile) return;
    try {
      const path = await save({
        defaultPath: activeProfile.name.replace(/[<>:"/\\|?*]/g, "_") + ".bms",
        filters: [{ name: "Blur Macro Script", extensions: ["bms"] }],
      });
      if (path) await writeTextFile(path, draft);
    } catch (err) {
      setRuntimeState("Error");
      setLogEntries((current) =>
        ["Export failed: " + String(err), ...current].slice(0, 100),
      );
    }
  };

  const refreshTargets = useCallback(async () => {
    if (refreshingTargetsRef.current) return;
    refreshingTargetsRef.current = true;
    try {
      const result = await invoke<MacroTarget[]>("list_target_windows");
      if (!macroPanelMountedRef.current) return;
      setTargets((current) =>
        targetWindowSignature(current) === targetWindowSignature(result)
          ? current
          : result,
      );
      const selectedTarget = macroDraftRef.current.target;
      if (
        selectedTarget &&
        !result.some(
          (target) =>
            targetOptionValue(target) === targetOptionValue(selectedTarget),
        )
      ) {
        targetProbeRequestRef.current += 1;
        setTargetCapabilities(
          "This target window is no longer open. Choose another window or clear the selection.",
        );
      } else {
        setTargetCapabilities((current) =>
          current.startsWith("Window list unavailable:") ||
          current.startsWith("This target window is no longer open.")
            ? ""
            : current,
        );
      }
    } catch (err) {
      if (macroPanelMountedRef.current)
        setTargetCapabilities("Window list unavailable: " + String(err));
    } finally {
      refreshingTargetsRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!settings.macroHotkeyOverride) return;
    void refreshTargets();
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void refreshTargets();
    };
    const interval = window.setInterval(refreshIfVisible, 15_000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [macroProfileId, refreshTargets, settings.macroHotkeyOverride]);

  const chooseTarget = async (selection: string) => {
    if (!activeProfile) return;
    if (!selection) {
      setDraft((current) => removeDirective(current, "target"));
      updateProfile(settings, update, activeProfile, {
        target: null,
        updatedAt: new Date().toISOString(),
      });
      clearTargetCapabilities();
      return;
    }
    const target =
      targets.find(
        (item) => `target:${targetOptionValue(item)}` === selection,
      ) ?? null;
    if (!target) return;
    setDraft((current) =>
      directive(current, "target", targetDirective(target)),
    );
    updateProfile(settings, update, activeProfile, {
      target,
      updatedAt: new Date().toISOString(),
    });
    const requestId = ++targetProbeRequestRef.current;
    setTargetCapabilities("Checking target capabilities…");
    try {
      const capabilities = await invoke<{
        backend: string;
        backgroundMouse: boolean;
        backgroundKeyboard: boolean;
        confirmedEffects: boolean;
        reason: string;
      }>("probe_target_window", { hwnd: target.hwnd });
      if (targetProbeRequestRef.current !== requestId) return;
      setTargetCapabilities(
        capabilities.backend +
          ": " +
          (capabilities.backgroundMouse
            ? "mouse messages can be queued"
            : "mouse unsupported") +
          ". " +
          capabilities.reason,
      );
    } catch (err) {
      if (targetProbeRequestRef.current !== requestId) return;
      setTargetCapabilities("Capability probe failed: " + String(err));
    }
  };

  const chooseMode = (mode: "foreground" | "background") => {
    const line =
      mode === "background" ? "mode background strict=true" : "mode foreground";
    setDraft((current) => directive(current, "mode", line));
  };

  const pickCoordinate = async () => {
    if (pickCoordinateActive) {
      setPickCoordinateActive(false);
      await invoke("cancel_click_point_pick").catch(() => {});
      return;
    }
    setPickCoordinateActive(true);
    try {
      await invoke("start_macro_coordinate_pick");
    } catch (err) {
      if (!macroPanelMountedRef.current) return;
      setPickCoordinateActive(false);
      setLogEntries((current) =>
        ["Coordinate picker failed: " + String(err), ...current].slice(0, 100),
      );
    }
  };

  const macroExecutionLocked =
    Boolean(recordingSessionId) ||
    running ||
    startingMacroRef.current ||
    startingCountdownRef.current ||
    runtimeState === "Recording";
  const recorderBusy =
    Boolean(recordingSessionId) ||
    recordingCountdown !== null ||
    startingCountdownRef.current ||
    preparingRecording ||
    startingRecordingRef.current ||
    runtimeState === "Recording";

  const setMacroEnabled = (enabled: boolean) => {
    if (!enabled && recordingCountdown !== null) {
      cancelRecordingCountdownRef.current();
    }
    if (!enabled && macroExecutionLocked) return;
    if (!enabled && pickCoordinateActive) {
      setPickCoordinateActive(false);
      void invoke("cancel_click_point_pick").catch(() => {});
    }
    update({ macroHotkeyOverride: enabled });
  };

  useEffect(() => {
    if (macroContentRef.current) {
      macroContentRef.current.inert = !settings.macroHotkeyOverride;
    }
  }, [settings.macroHotkeyOverride]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cleanupEnded: (() => void) | undefined;
    let disposed = false;
    listen<{
      kind: "click" | "drag";
      button: "left" | "right";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      points: { x: number; y: number; elapsedMs: number }[];
    }>("macro-gesture-picked", (event) => {
      const gesture = event.payload;
      const lines =
        gesture.kind === "click"
          ? [
              `move x=${gesture.endX} y=${gesture.endY} space=screen`,
              `click button=${gesture.button} count=1 radius=0`,
            ]
          : [
              `move x=${gesture.startX} y=${gesture.startY} space=screen`,
              `mouse_down button=${gesture.button}`,
              ...gesture.points.map((point, index) => {
                const previousElapsed =
                  index === 0 ? 0 : (gesture.points[index - 1]?.elapsedMs ?? 0);
                const duration = Math.max(1, point.elapsedMs - previousElapsed);
                return `move x=${point.x} y=${point.y} space=screen duration=${duration}ms`;
              }),
              `mouse_up button=${gesture.button}`,
            ];
      setDraft((current) => {
        const base =
          gesture.kind === "drag"
            ? directive(current, "mode", "mode foreground")
            : current;
        return (
          base + (base.endsWith("\n") || !base ? "" : "\n") + lines.join("\n")
        );
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanup = unlisten;
    });
    listen("click-pick-ended", () => setPickCoordinateActive(false)).then(
      (unlisten) => {
        if (disposed) unlisten();
        else cleanupEnded = unlisten;
      },
    );
    return () => {
      disposed = true;
      cleanup?.();
      cleanupEnded?.();
      void invoke("cancel_click_point_pick");
    };
  }, []);

  const startRecording = async () => {
    if (startingMacroRef.current) {
      cancelRecordingCountdownRef.current();
      return;
    }
    if (runningRef.current) {
      cancelRecordingCountdownRef.current();
      setRuntimeState("Running");
      return;
    }
    if (startingRecordingRef.current || recordingSessionRef.current) return;
    startingRecordingRef.current = true;
    let pendingStart: Promise<string> | null = null;
    if (recordedEventsRenderTimerRef.current !== null) {
      window.clearTimeout(recordedEventsRenderTimerRef.current);
      recordedEventsRenderTimerRef.current = null;
    }
    recordedEventsRef.current = [];
    setRecordedEvents([]);
    setRecorderNotice("");
    setTimelinePage(null);
    setRecordingFinished(false);
    setSelectedTimelineIndex(null);
    setRuntimeState("Recording");
    try {
      pendingStart = invoke<string>("recorder_start", {
        recordCursorMovement,
      });
      pendingRecordingStartRef.current = pendingStart;
      const session = await pendingStart;
      if (!macroPanelMountedRef.current) return;
      if (lastStoppedSessionLoggedRef.current !== session) {
        recordingSessionRef.current = session;
        setRecordingSessionId(session);
      }
    } catch (err) {
      if (!macroPanelMountedRef.current) return;
      setRecorderNotice("Recording could not start: " + String(err));
      setRuntimeState("Error");
      setLogEntries((current) =>
        ["Recording could not start: " + String(err), ...current].slice(0, 100),
      );
    } finally {
      if (pendingRecordingStartRef.current === pendingStart) {
        pendingRecordingStartRef.current = null;
      }
      startingRecordingRef.current = false;
    }
  };

  const cancelRecordingCountdown = () => {
    if (recordingCountdownTimerRef.current !== null) {
      window.clearInterval(recordingCountdownTimerRef.current);
      recordingCountdownTimerRef.current = null;
    }
    setRecordingCountdown(null);
  };
  cancelRecordingCountdownRef.current = cancelRecordingCountdown;

  const beginRecordingCountdown = async () => {
    if (
      runningRef.current ||
      startingMacroRef.current ||
      startingRecordingRef.current ||
      recordingSessionRef.current ||
      startingCountdownRef.current ||
      recordingCountdownTimerRef.current !== null
    )
      return;
    startingCountdownRef.current = true;
    setPreparingRecording(true);
    setRecorderNotice("");
    try {
      if (pickCoordinateActive) {
        setPickCoordinateActive(false);
        await invoke("cancel_click_point_pick");
        if (!macroPanelMountedRef.current) return;
        if (
          runningRef.current ||
          startingMacroRef.current ||
          startingRecordingRef.current ||
          recordingSessionRef.current ||
          recordingCountdownTimerRef.current !== null
        )
          return;
      }
      const seconds = Math.max(
        0,
        Math.min(30, Math.trunc(recordingCountdownSeconds)),
      );
      if (seconds === 0) {
        void startRecording();
        return;
      }

      const endAt = Date.now() + seconds * 1000;
      setRecordingCountdown(seconds);
      recordingCountdownTimerRef.current = window.setInterval(() => {
        const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        if (remaining === 0) {
          if (recordingCountdownTimerRef.current !== null) {
            window.clearInterval(recordingCountdownTimerRef.current);
            recordingCountdownTimerRef.current = null;
          }
          setRecordingCountdown(null);
          void startRecording();
          return;
        }
        setRecordingCountdown(remaining);
      }, 100);
    } catch (err) {
      if (!macroPanelMountedRef.current) return;
      setLogEntries((current) =>
        [
          "Could not stop Pick Point before recording: " + String(err),
          ...current,
        ].slice(0, 100),
      );
      setRecorderNotice(
        "Could not stop Pick Point before recording: " + String(err),
      );
    } finally {
      startingCountdownRef.current = false;
      if (macroPanelMountedRef.current) setPreparingRecording(false);
    }
  };

  useEffect(
    () => () => {
      if (recordingCountdownTimerRef.current !== null) {
        window.clearInterval(recordingCountdownTimerRef.current);
        recordingCountdownTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (running) cancelRecordingCountdownRef.current();
  }, [running]);

  const stopRecording = async () => {
    if (!recordingSessionId) return;
    try {
      const result = await invoke<{
        eventCount: number;
        source: string;
        events: RecorderEvent[];
        sessionId: string;
      }>("recorder_stop", { sessionId: recordingSessionId });
      if (!macroPanelMountedRef.current) return;
      const shouldLogResult =
        lastStoppedSessionLoggedRef.current !== result.sessionId;
      lastStoppedSessionLoggedRef.current = result.sessionId;
      recordingSessionRef.current = null;
      setRecordingSessionId(null);
      setDraft(result.source);
      setRecordedEvents(result.events);
      setTimelinePage(null);
      setRuntimeState("Idle");
      setRecordingFinished(true);
      setSelectedTimelineIndex(null);
      setValidation(null);
      if (shouldLogResult) {
        setLogEntries((current) =>
          [
            "Recording captured " +
              result.eventCount +
              " events. Review before replay.",
            ...current,
          ].slice(0, 100),
        );
      }
    } catch (err) {
      if (!macroPanelMountedRef.current) return;
      setRecorderNotice("Recording could not stop: " + String(err));
      setRuntimeState("Error");
      setLogEntries((current) =>
        ["Recording stop failed: " + String(err), ...current].slice(0, 100),
      );
    }
  };

  const moveTimelineEvent = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (
      !recordingFinished ||
      index < 0 ||
      nextIndex < 0 ||
      nextIndex >= recordedEvents.length
    )
      return;
    const next = [...recordedEvents];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    const timeSlots = recordedEvents
      .map((event) => event.atMs)
      .sort((a, b) => a - b);
    setRecordedEvents(
      next.map((event, slot) => ({ ...event, atMs: timeSlots[slot] })),
    );
    setTimelinePage(Math.floor(nextIndex / TIMELINE_PAGE_SIZE));
    setSelectedTimelineIndex(nextIndex);
  };

  const removeTimelineEvent = (index: number) => {
    if (!recordingFinished) return;
    setRecordedEvents((current) =>
      current.filter((_, eventIndex) => eventIndex !== index),
    );
    setSelectedTimelineIndex((current) =>
      current === null
        ? null
        : current === index
          ? null
          : current > index
            ? current - 1
            : current,
    );
  };

  const trimTimeline = (side: "before" | "after") => {
    if (!recordingFinished || selectedTimelineIndex === null) return;
    setRecordedEvents((current) => {
      if (side === "after") return current.slice(0, selectedTimelineIndex + 1);
      const kept = current.slice(selectedTimelineIndex);
      const firstTimestamp = kept[0]?.atMs ?? 0;
      return kept.map((event) => ({
        ...event,
        atMs: Math.max(0, event.atMs - firstTimestamp),
      }));
    });
    if (side === "before") setTimelinePage(0);
    setSelectedTimelineIndex(side === "before" ? 0 : selectedTimelineIndex);
  };

  const applyTimelineEdits = async () => {
    try {
      const source = await invoke<string>("recorder_events_to_script", {
        events: recordedEvents,
      });
      setDraft(source);
      setValidation(null);
      setRuntimeState("Idle");
      setView("editor");
      setLogEntries((current) =>
        [
          "Applied " +
            recordedEvents.length +
            " edited recording events to the editor.",
          ...current,
        ].slice(0, 100),
      );
    } catch (err) {
      setLogEntries((current) =>
        ["Could not convert edited timeline: " + String(err), ...current].slice(
          0,
          100,
        ),
      );
    }
  };

  const startMacro = async () => {
    if (pickCoordinateActive) {
      setLogEntries((current) =>
        ["Turn Pick Point off before running a macro.", ...current].slice(
          0,
          100,
        ),
      );
      return;
    }
    if (
      startingMacroRef.current ||
      recordingSessionId ||
      recordingSessionRef.current ||
      startingRecordingRef.current ||
      runtimeState === "Recording" ||
      recordingCountdown !== null ||
      recordingCountdownTimerRef.current !== null ||
      !activeProfile
    )
      return;
    startingMacroRef.current = true;
    const sourceAtStart = draft;
    const nameAtStart = draftName;
    const profileIdAtStart = activeProfile.id;
    const targetAtStart = activeProfile.target;
    try {
      const result = await runValidation();
      if (!result?.ok) {
        setView("editor");
        return;
      }
      const latest = macroDraftRef.current;
      if (
        latest.source !== sourceAtStart ||
        latest.name !== nameAtStart ||
        latest.profileId !== profileIdAtStart ||
        latest.target?.hwnd !== targetAtStart?.hwnd ||
        latest.target?.pid !== targetAtStart?.pid
      ) {
        setRuntimeState("Idle");
        setLogEntries((current) =>
          [
            "Macro changed during validation. Review it and run again.",
            ...current,
          ].slice(0, 100),
        );
        return;
      }
      saveDraft(sourceAtStart, nameAtStart);
      setLogEntries([]);
      setRuntimeState("Validating");
      await onRun(
        sourceAtStart,
        targetAtStart?.hwnd ?? null,
        targetAtStart?.pid ?? null,
      );
      setRuntimeState("Running");
      setView("history");
    } catch (err) {
      setRuntimeState("Error");
      setLogEntries((current) =>
        ["Macro could not start: " + String(err), ...current].slice(0, 100),
      );
    } finally {
      startingMacroRef.current = false;
    }
  };

  const selectedTarget = activeProfile?.target;
  const backgroundMode = /^\s*mode\s+background/m.test(draft);
  const selectedTargetIsAvailable =
    selectedTarget !== null &&
    selectedTarget !== undefined &&
    targets.some(
      (target) =>
        targetOptionValue(target) === targetOptionValue(selectedTarget),
    );
  const targetDropdownValue = selectedTarget
    ? selectedTargetIsAvailable
      ? `target:${targetOptionValue(selectedTarget)}`
      : `unavailable:${targetOptionValue(selectedTarget)}`
    : "";
  const targetOptions = [
    { value: "", label: "Select a window…" },
    ...(selectedTarget && !selectedTargetIsAvailable
      ? [
          {
            value: `unavailable:${targetOptionValue(selectedTarget)}`,
            label: `Unavailable — ${selectedTarget.processName}${selectedTarget.title ? ` · ${selectedTarget.title}` : ""}`,
            disabled: true,
          },
        ]
      : []),
    ...targets.map((target) => ({
      value: `target:${targetOptionValue(target)}`,
      label: `${target.title} — ${target.processName} (PID ${target.pid})`,
    })),
  ];
  const macroRunHotkeyConflicts = [
    { label: "Clicker trigger", value: settings.hotkey },
    { label: "Master hotkey", value: settings.keybindMaster },
    { label: "Record hotkey", value: settings.recordingHotkey },
    { label: "Emergency stop", value: settings.emergencyStopHotkey },
  ];
  const recordHotkeyConflicts = [
    { label: "Clicker trigger", value: settings.hotkey },
    { label: "Master hotkey", value: settings.keybindMaster },
    { label: "Macro Hot Key", value: settings.macroRunHotkey },
    { label: "Emergency stop", value: settings.emergencyStopHotkey },
  ];

  return (
    <div className="adv-panel adv-panel-text macro-panel">
      <div className="adv-col">
        <div className="adv-sectioncontainer macro-main-card">
          <div className="adv-card-header macro-panel-header">
            <div className="macro-panel-title">
              <InfoIcon
                text={
                  settings.macroHotkeyOverride
                    ? "The clicker trigger and any assigned Macro Hot Key run the active macro."
                    : "Turn Macro on to edit, record, and run macros."
                }
              />
              <span className="adv-card-title">Macro</span>
            </div>
            <div
              className="macro-enable-toggle adv-toggle-group"
              role="group"
              aria-label="Macro enabled"
            >
              <button
                type="button"
                className={`adv-toggle-btn adv-toggle-off ${!settings.macroHotkeyOverride ? "active" : ""}`}
                aria-pressed={!settings.macroHotkeyOverride}
                disabled={macroExecutionLocked || !settings.macroHotkeyOverride}
                onClick={() => setMacroEnabled(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={`adv-toggle-btn adv-toggle-on ${settings.macroHotkeyOverride ? "active" : ""}`}
                aria-pressed={settings.macroHotkeyOverride}
                disabled={macroExecutionLocked || settings.macroHotkeyOverride}
                onClick={() => setMacroEnabled(true)}
              >
                On
              </button>
            </div>
          </div>
          <CardDivider />

          <MacroRunHotkeyInput
            value={settings.macroRunHotkey}
            conflicts={macroRunHotkeyConflicts}
            disabled={macroExecutionLocked}
            onChange={(macroRunHotkey) => update({ macroRunHotkey })}
          />

          <div
            ref={macroContentRef}
            className={`macro-content ${settings.macroHotkeyOverride ? "" : "is-disabled"}`}
            aria-disabled={!settings.macroHotkeyOverride}
          >
            {recordingSessionId && (
              <div
                className="macro-recorder-active"
                role="status"
                aria-live="polite"
              >
                Recording is active.
                <button
                  className="adv-secondary-btn macro-button macro-button-danger"
                  onClick={() => void stopRecording()}
                >
                  Stop Recording
                </button>
              </div>
            )}
            <div className="macro-config-card">
              <div className="macro-toolbar">
                <AdvDropdown
                  className="macro-select"
                  portalClassName="macro-dropdown-menu"
                  ariaLabel="Active macro"
                  value={activeProfile?.id ?? ""}
                  options={settings.macroProfiles.map((profile) => ({
                    value: profile.id,
                    label: profile.name,
                  }))}
                  hoverWheel={false}
                  onChange={selectProfile}
                  disabled={!settings.macroHotkeyOverride || recorderBusy}
                />
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={createMacro}
                  disabled={recorderBusy}
                >
                  New
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={() => saveDraft()}
                  disabled={recorderBusy}
                >
                  Save
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={duplicateMacro}
                  disabled={!activeProfile || recorderBusy}
                >
                  Duplicate
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={deleteMacro}
                  disabled={
                    !activeProfile ||
                    settings.macroProfiles.length <= 1 ||
                    recorderBusy
                  }
                >
                  Delete
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={importMacro}
                  disabled={recorderBusy}
                >
                  Import
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={exportMacro}
                  disabled={!activeProfile}
                >
                  Export
                </button>
                <span className="macro-dirty">
                  {isDirty ? "Unsaved changes" : "Saved"}
                </span>
              </div>

              <div className="macro-target-row">
                <label className="macro-name">
                  <span>Macro</span>
                  <input
                    value={draftName}
                    aria-label="Macro name"
                    maxLength={80}
                    disabled={recorderBusy}
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={() => {
                      const normalizedName =
                        draftName.trim().slice(0, 80) || "New Macro";
                      setDraftName(normalizedName);
                      if (
                        activeProfile &&
                        normalizedName !== activeProfile.name
                      ) {
                        updateProfile(settings, update, activeProfile, {
                          name: normalizedName,
                          updatedAt: new Date().toISOString(),
                        });
                      }
                    }}
                  />
                </label>
                <div className="macro-target">
                  <span className="macro-target-label">Target Window</span>
                  <div className="macro-target-control">
                    <AdvDropdown
                      className="macro-target-dropdown"
                      portalClassName="macro-dropdown-menu"
                      ariaLabel="Target Window"
                      value={targetDropdownValue}
                      options={targetOptions}
                      hoverWheel={false}
                      disabled={!settings.macroHotkeyOverride || recorderBusy}
                      onChange={(hwnd) => void chooseTarget(hwnd)}
                    />
                  </div>
                </div>
                <label className="macro-mode">
                  <span>Mode</span>
                  <AdvDropdown
                    className="macro-mode-dropdown"
                    portalClassName="macro-dropdown-menu"
                    ariaLabel="Execution mode"
                    value={backgroundMode ? "background" : "foreground"}
                    options={[
                      { value: "foreground", label: "Foreground" },
                      { value: "background", label: "Background (strict)" },
                    ]}
                    hoverWheel={false}
                    disabled={!settings.macroHotkeyOverride || recorderBusy}
                    onChange={(mode) =>
                      chooseMode(mode as "foreground" | "background")
                    }
                  />
                </label>
              </div>
              {targetCapabilities && (
                <div className="macro-capability" role="status">
                  {targetCapabilities}
                </div>
              )}
            </div>

            <div
              className="macro-subnav adv-seg-group"
              role="tablist"
              aria-label="Macro views"
            >
              {(
                [
                  ["editor", "Editor"],
                  ["record", "Record Actions"],
                  ["history", "Run / History"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={view === id}
                  className={`macro-subtab adv-seg-btn ${view === id ? "active" : ""}`}
                  onClick={() => setView(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {view === "editor" && (
              <section className="macro-editor-view" aria-label="Macro editor">
                <div className="macro-editor-heading">
                  <div>
                    <span className="adv-card-title">
                      Editor &amp; Action Map
                    </span>
                    <small>
                      {pickCoordinateActive
                        ? "Outside this window, L/R-click adds clicks; hold and drag adds a foreground pan. Esc/Off stops."
                        : "Outside this window, L/R-click adds clicks; hold and drag adds a pan."}
                    </small>
                  </div>
                  <button
                    className={`adv-secondary-btn macro-button ${pickCoordinateActive ? "macro-button-primary" : ""}`}
                    aria-pressed={pickCoordinateActive}
                    disabled={recorderBusy || running}
                    onClick={() => void pickCoordinate()}
                  >
                    Pick Point {pickCoordinateActive ? "On" : "Off"}
                  </button>
                </div>
                <div className="macro-editor-workspace">
                  <div className="macro-editor">
                    <MacroCodeEditor
                      value={draft}
                      errors={editorErrors}
                      editable={!recorderBusy}
                      onChange={handleDraftChange}
                    />
                  </div>
                  <MacroVisualization source={draft} />
                </div>
                <div
                  className="macro-diagnostics"
                  role="status"
                  aria-live="polite"
                >
                  {validationPending
                    ? "Validating…"
                    : hasCurrentValidation && validation?.ok
                      ? "Valid · " + validation.statementCount + " statements"
                      : hasCurrentValidation && validation?.errors.length
                        ? validation.errors
                            .slice(0, 3)
                            .map(
                              (error) =>
                                "Line " +
                                error.line +
                                ", column " +
                                error.column +
                                ": " +
                                error.message,
                            )
                            .join("  •  ")
                        : "Write a statement, then validate the script."}
                </div>
              </section>
            )}

            {view === "record" && (
              <section className="macro-record-view">
                {recorderNotice && (
                  <div
                    className={
                      "macro-recorder-status" +
                      (recorderNoticeIsError ? " is-error" : "")
                    }
                    role={recorderNoticeIsError ? "alert" : "status"}
                    aria-live={recorderNoticeIsError ? "assertive" : "polite"}
                  >
                    {recorderNotice}
                  </div>
                )}
                <div className="macro-recorder-options">
                  <label className="macro-recorder-countdown">
                    <span>Start after</span>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      step={1}
                      value={recordingCountdownSeconds}
                      aria-label="Recording countdown in seconds"
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setRecordingCountdownSeconds(
                          Number.isFinite(value)
                            ? Math.max(0, Math.min(30, Math.trunc(value)))
                            : 0,
                        );
                      }}
                      disabled={recorderBusy}
                    />
                    <span>seconds</span>
                  </label>
                </div>
                <label className="macro-recorder-mode">
                  <span>Mouse recording</span>
                  <AdvDropdown
                    portalClassName="macro-dropdown-menu"
                    ariaLabel="Mouse recording mode"
                    value={recordCursorMovement ? "all-movement" : "drag-paths"}
                    options={[
                      { value: "drag-paths", label: "Drag paths only" },
                      {
                        value: "all-movement",
                        label: "All movement (sampled)",
                      },
                    ]}
                    hoverWheel={false}
                    disabled={!settings.macroHotkeyOverride || recorderBusy}
                    onChange={(mode) => {
                      const enabled = mode === "all-movement";
                      setRecordCursorMovement(enabled);
                      update({ recordCursorMovement: enabled });
                    }}
                  />
                  <small>
                    Drag mode records paths while holding the left, middle, or
                    right mouse button. The other mode also captures free cursor
                    movement; clicks and scrolling are always recorded.
                  </small>
                </label>
                <div className="macro-hotkey-settings">
                  <div className="macro-record-hotkey-setting">
                    <span>Record hotkey</span>
                    <HotkeyCaptureInput
                      ariaLabel="Recording hotkey"
                      value={settings.recordingHotkey}
                      onChange={(recordingHotkey) => {
                        const conflict = recordHotkeyConflicts.find(
                          (item) =>
                            item.value &&
                            hotkeyIdentity(item.value) ===
                              hotkeyIdentity(recordingHotkey),
                        );
                        if (conflict) {
                          setRecorderNotice(
                            `Could not set Record hotkey: already assigned to ${conflict.label}.`,
                          );
                          return;
                        }
                        setRecorderNotice("");
                        update({ recordingHotkey });
                      }}
                      className="settings-keybind-capture macro-record-hotkey-capture"
                      conflicts={recordHotkeyConflicts
                        .filter(
                          (item) =>
                            item.value &&
                            hotkeyIdentity(item.value) ===
                              hotkeyIdentity(settings.recordingHotkey),
                        )
                        .map((item) => item.label)}
                      editable={!recorderBusy}
                    />
                  </div>
                  <label>
                    <span>Emergency stop</span>
                    <input
                      aria-label="Emergency stop hotkey"
                      value={settings.emergencyStopHotkey}
                      onChange={(event) =>
                        update({ emergencyStopHotkey: event.target.value })
                      }
                      disabled={recorderBusy}
                    />
                  </label>
                </div>
                <div className="macro-recorder-controls">
                  {recordingSessionId ? (
                    <button
                      className="adv-secondary-btn macro-button macro-button-danger"
                      onClick={() => void stopRecording()}
                    >
                      Stop Recording
                    </button>
                  ) : recordingCountdown !== null ? (
                    <button
                      className="adv-secondary-btn macro-button macro-button-danger"
                      onClick={cancelRecordingCountdown}
                    >
                      Cancel · {recordingCountdown}
                    </button>
                  ) : (
                    <button
                      className="adv-secondary-btn macro-button macro-button-primary"
                      disabled={
                        running || startingMacroRef.current || recorderBusy
                      }
                      aria-busy={preparingRecording}
                      onClick={() => void beginRecordingCountdown()}
                    >
                      {preparingRecording ? "Preparing…" : "Start Recording"}
                    </button>
                  )}
                  <span
                    className="macro-state-pill"
                    data-state={
                      recordingSessionId
                        ? "Recording"
                        : recordingCountdown !== null
                          ? "Countdown"
                          : preparingRecording
                            ? "Preparing"
                            : runtimeState
                    }
                  >
                    {recordingSessionId
                      ? "Recording"
                      : recordingCountdown !== null
                        ? "Starting in " + recordingCountdown + "s"
                        : preparingRecording
                          ? "Preparing recorder…"
                          : runtimeState}
                  </span>
                  <span>{recordedEvents.length} events</span>
                </div>
                {recordingFinished && (
                  <div className="macro-timeline-edit-controls">
                    <span>
                      {selectedTimelineIndex === null
                        ? "Select an event to trim the recording."
                        : "Selected event " + (selectedTimelineIndex + 1)}
                    </span>
                    <button
                      className="adv-secondary-btn macro-button"
                      disabled={selectedTimelineIndex === null}
                      onClick={() => trimTimeline("before")}
                    >
                      Trim before
                    </button>
                    <button
                      className="adv-secondary-btn macro-button"
                      disabled={selectedTimelineIndex === null}
                      onClick={() => trimTimeline("after")}
                    >
                      Trim after
                    </button>
                    <button
                      className="adv-secondary-btn macro-button macro-button-primary"
                      disabled={!recordedEvents.length}
                      onClick={() => void applyTimelineEdits()}
                    >
                      Apply Timeline to Editor
                    </button>
                  </div>
                )}
                {recordedEvents.length > TIMELINE_PAGE_SIZE && (
                  <div className="macro-timeline-pagination">
                    <span>
                      Events {timelineStart + 1}–
                      {Math.min(
                        timelineStart + TIMELINE_PAGE_SIZE,
                        recordedEvents.length,
                      )}{" "}
                      of {recordedEvents.length}
                    </span>
                    <button
                      className="adv-secondary-btn macro-button"
                      disabled={currentTimelinePage === 0}
                      onClick={() =>
                        setTimelinePage(Math.max(0, currentTimelinePage - 1))
                      }
                    >
                      Previous
                    </button>
                    <button
                      className="adv-secondary-btn macro-button"
                      disabled={timelinePage === null}
                      onClick={() => setTimelinePage(null)}
                    >
                      Latest
                    </button>
                    <button
                      className="adv-secondary-btn macro-button"
                      disabled={currentTimelinePage >= timelinePageCount - 1}
                      onClick={() =>
                        setTimelinePage(
                          Math.min(
                            currentTimelinePage + 1,
                            timelinePageCount - 1,
                          ),
                        )
                      }
                    >
                      Next
                    </button>
                  </div>
                )}
                <ol
                  className="macro-timeline"
                  aria-label="Recorded action timeline"
                >
                  {visibleTimelineEvents.map((event, pageIndex) => {
                    const index = timelineStart + pageIndex;
                    return (
                      <li key={index}>
                        <time>{event.atMs} ms</time>
                        <button
                          className="adv-secondary-btn macro-timeline-event"
                          aria-pressed={selectedTimelineIndex === index}
                          onClick={() => setSelectedTimelineIndex(index)}
                        >
                          {describeEvent(event)}
                        </button>
                        {recordingFinished && (
                          <span className="macro-timeline-event-actions">
                            <button
                              className="adv-secondary-btn macro-button"
                              aria-label={"Move event " + (index + 1) + " up"}
                              disabled={index === 0}
                              onClick={() => moveTimelineEvent(index, -1)}
                            >
                              ↑
                            </button>
                            <button
                              className="adv-secondary-btn macro-button"
                              aria-label={"Move event " + (index + 1) + " down"}
                              disabled={index === recordedEvents.length - 1}
                              onClick={() => moveTimelineEvent(index, 1)}
                            >
                              ↓
                            </button>
                            <button
                              className="adv-secondary-btn macro-button macro-button-danger"
                              aria-label={"Delete event " + (index + 1)}
                              onClick={() => removeTimelineEvent(index)}
                            >
                              ×
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                  {recordedEvents.length === 0 && (
                    <li className="macro-timeline-empty">
                      Recorded actions appear here.
                    </li>
                  )}
                </ol>
                <p className="macro-recorder-note">
                  Stopping recording converts the captured ordering and delays
                  to editable BMScript and opens it in Editor. Playback never
                  starts automatically.
                </p>
              </section>
            )}

            {view === "history" && (
              <section className="macro-history-view">
                <div className="macro-run-summary">
                  <div>
                    <strong>
                      {activeProfile?.name ?? "No macro selected"}
                    </strong>
                    <span>
                      {selectedTarget
                        ? selectedTarget.processName +
                          " · " +
                          selectedTarget.title
                        : "No target selected"}
                    </span>
                  </div>
                  <span
                    className="macro-state-pill"
                    data-state={
                      paused ? "Paused" : running ? "Running" : runtimeState
                    }
                  >
                    {paused ? "Paused" : running ? "Running" : runtimeState}
                  </span>
                </div>
                <div className="macro-run-controls">
                  {running ? (
                    <>
                      {paused ? (
                        <button
                          className="adv-secondary-btn macro-button"
                          onClick={() => void invoke("macro_resume")}
                        >
                          Resume
                        </button>
                      ) : (
                        <button
                          className="adv-secondary-btn macro-button"
                          onClick={() => void invoke("macro_pause")}
                        >
                          Pause
                        </button>
                      )}
                      <button
                        className="adv-secondary-btn macro-button macro-button-danger"
                        onClick={() => void invoke("macro_stop")}
                      >
                        Stop · {primaryHotkey}
                      </button>
                    </>
                  ) : (
                    <button
                      className="adv-secondary-btn macro-button macro-button-primary"
                      disabled={
                        Boolean(recordingSessionId) ||
                        recordingCountdown !== null ||
                        startingRecordingRef.current ||
                        runtimeState === "Recording" ||
                        startingMacroRef.current ||
                        !activeProfile
                      }
                      onClick={() => void startMacro()}
                    >
                      Run · {primaryHotkey}
                    </button>
                  )}
                  <span>Executing step {activeStep}</span>
                </div>
                {(statusError || stopReason) && (
                  <div
                    className={
                      statusError ? "macro-run-error" : "macro-run-reason"
                    }
                  >
                    {statusError ?? stopReason}
                  </div>
                )}
                <ol className="macro-history-list" aria-label="Run history">
                  {logEntries.map((entry, index) => (
                    <li key={index}>{entry}</li>
                  ))}
                  {logEntries.length === 0 && (
                    <li>
                      Run, recording, validation and error events appear here.
                    </li>
                  )}
                </ol>
                {backgroundMode && (
                  <p className="macro-unverified">
                    Background Win32 input is queued and marked unverified. The
                    app cannot confirm that the target acted on a message.
                  </p>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title ?? ""}
        message={confirmation?.message ?? ""}
        confirmLabel={confirmation?.confirmLabel ?? "Confirm"}
        onConfirm={confirmPendingAction}
        onCancel={cancelConfirmation}
      />
    </div>
  );
}
