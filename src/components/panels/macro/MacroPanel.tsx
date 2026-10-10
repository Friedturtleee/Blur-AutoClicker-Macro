import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdvDropdown,
  CardDivider,
  InfoIcon,
} from "../advanced/sections/shared";
import MacroCodeEditor from "./MacroCodeEditor";
import MacroVisualization from "./MacroVisualization";
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
  const index = lines.findIndex((line) =>
    line.trimStart().startsWith(kind + " "),
  );
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
  const [recordCursorMovement, setRecordCursorMovement] = useState(
    settings.recordCursorMovement,
  );
  const [recordingSessionId, setRecordingSessionId] = useState<string | null>(
    null,
  );
  const [recordedEvents, setRecordedEvents] = useState<RecorderEvent[]>([]);
  const [recordingCountdownSeconds, setRecordingCountdownSeconds] = useState(3);
  const [recordingCountdown, setRecordingCountdown] = useState<number | null>(
    null,
  );
  const recordedEventsRef = useRef<RecorderEvent[]>([]);
  const recordedEventsRenderTimerRef = useRef<number | null>(null);
  const recordingCountdownTimerRef = useRef<number | null>(null);
  const cancelRecordingCountdownRef = useRef<() => void>(() => {});
  const [timelinePage, setTimelinePage] = useState<number | null>(null);
  const [recordingFinished, setRecordingFinished] = useState(false);
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<
    number | null
  >(null);
  const [pickCoordinateActive, setPickCoordinateActive] = useState(false);
  const macroContentRef = useRef<HTMLDivElement>(null);
  const handleDraftChange = useCallback((value: string) => setDraft(value), []);
  const lastStoppedSessionLoggedRef = useRef<string | null>(null);
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
  const editorErrors = useMemo(
    () =>
      validatedSource === draft && !validating
        ? (validation?.errors ?? [])
        : [],
    [draft, validatedSource, validating, validation],
  );
  const hasCurrentValidation = validatedSource === draft && !validating;
  const validationPending = Boolean(draft.trim()) && !hasCurrentValidation;

  useEffect(() => {
    onDirtyChange(isDirty);
    return () => onDirtyChange(false);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!activeProfile || draftId === activeProfile.id) return;
    setDraftId(activeProfile.id);
    setDraft(activeProfile.source);
    setDraftName(activeProfile.name);
    setValidation(null);
  }, [activeProfile, draftId]);

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
    const addListener = async <T,>(
      eventName: string,
      listener: (payload: T) => void,
    ) => {
      const unlisten = await listen<T>(eventName, (event) =>
        listener(event.payload),
      );
      if (disposed) unlisten();
      else cleanups.push(unlisten);
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
    void addListener<string>("recorder:warning", (message) =>
      setLogEntries((current) => [message, ...current].slice(0, 100)),
    );
    void addListener<{
      state: string;
      sessionId?: string;
      recordCursorMovement?: boolean;
    }>("recorder:state", (event) => {
      if (event.state === "Recording") {
        cancelRecordingCountdownRef.current();
        if (recordedEventsRenderTimerRef.current !== null) {
          window.clearTimeout(recordedEventsRenderTimerRef.current);
          recordedEventsRenderTimerRef.current = null;
        }
        recordingSessionRef.current = event.sessionId ?? "active";
        recordedEventsRef.current = [];
        lastStoppedSessionLoggedRef.current = null;
        setRecordingSessionId(event.sessionId ?? null);
        setRuntimeState("Recording");
        setRecordedEvents([]);
        setTimelinePage(null);
        setRecordingFinished(false);
        setSelectedTimelineIndex(null);
      } else if (event.state === "Stopped") {
        if (
          event.sessionId &&
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
      setRuntimeState("Error");
      setLogEntries((current) => [message, ...current].slice(0, 100));
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
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

  useEffect(() => {
    return () => {
      if (pickCoordinateActive) void invoke("cancel_click_point_pick");
    };
  }, [pickCoordinateActive]);

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
    if (isDirty && !window.confirm("Discard unsaved macro changes?")) return;
    const profile = settings.macroProfiles.find((item) => item.id === id);
    if (!profile) return;
    update({ activeMacroId: id });
    setDraftId(profile.id);
    setDraft(profile.source);
    setDraftName(profile.name);
    setValidation(null);
    setValidatedSource(null);
  };

  const createMacro = () => {
    if (isDirty && !window.confirm("Discard unsaved macro changes?")) return;
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
  };

  const duplicateMacro = () => {
    if (!activeProfile) return;
    const now = new Date().toISOString();
    const copy: MacroProfile = {
      ...activeProfile,
      id: makeId(),
      name: (activeProfile.name + " copy").slice(0, 80),
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
  };

  const deleteMacro = () => {
    if (!activeProfile) return;
    if (!window.confirm("Delete “" + activeProfile.name + "”?")) return;
    const profiles = settings.macroProfiles.filter(
      (profile) => profile.id !== activeProfile.id,
    );
    const next = profiles[0];
    update({ macroProfiles: profiles, activeMacroId: next?.id ?? null });
    setDraftId(next?.id ?? "");
    setDraft(next?.source ?? "");
    setDraftName(next?.name ?? "");
  };

  const importMacro = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Blur Macro Script", extensions: ["bms"] }],
      });
      if (typeof selected !== "string") return;
      const source = await readTextFile(selected);
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
      setView("editor");
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

  const refreshTargets = async () => {
    try {
      const result = await invoke<MacroTarget[]>("list_target_windows");
      setTargets(result);
    } catch (err) {
      setTargetCapabilities("Window list unavailable: " + String(err));
    }
  };

  useEffect(() => {
    void refreshTargets();
    // Initial target discovery only; the Refresh button handles later changes.
  }, []);

  const chooseTarget = async (hwnd: string) => {
    const target = targets.find((item) => String(item.hwnd) === hwnd) ?? null;
    if (!target || !activeProfile) return;
    setDraft((current) =>
      directive(current, "target", targetDirective(target)),
    );
    updateProfile(settings, update, activeProfile, { target });
    try {
      const capabilities = await invoke<{
        backend: string;
        backgroundMouse: boolean;
        backgroundKeyboard: boolean;
        confirmedEffects: boolean;
        reason: string;
      }>("probe_target_window", { hwnd: target.hwnd });
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
      setPickCoordinateActive(false);
      setLogEntries((current) =>
        ["Coordinate picker failed: " + String(err), ...current].slice(0, 100),
      );
    }
  };

  const setMacroEnabled = (enabled: boolean) => {
    if (!enabled && (recordingSessionId || running)) return;
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
    listen<{ x: number; y: number; continuePicking: boolean }>(
      "macro-coordinate-picked",
      (event) => {
        setDraft(
          (current) =>
            current +
            (current.endsWith("\n") || !current ? "" : "\n") +
            "move x=" +
            event.payload.x +
            " y=" +
            event.payload.y +
            " space=screen\nclick button=left count=1 radius=0",
        );
        if (!event.payload.continuePicking) setPickCoordinateActive(false);
      },
    ).then((unlisten) => {
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
    if (startingRecordingRef.current || recordingSessionRef.current) return;
    startingRecordingRef.current = true;
    let pendingStart: Promise<string> | null = null;
    if (recordedEventsRenderTimerRef.current !== null) {
      window.clearTimeout(recordedEventsRenderTimerRef.current);
      recordedEventsRenderTimerRef.current = null;
    }
    recordedEventsRef.current = [];
    setRecordedEvents([]);
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
      if (lastStoppedSessionLoggedRef.current !== session) {
        recordingSessionRef.current = session;
        setRecordingSessionId(session);
      }
    } catch (err) {
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

  const beginRecordingCountdown = () => {
    if (recordingCountdownTimerRef.current !== null) return;
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

  const stopRecording = async () => {
    if (!recordingSessionId) return;
    try {
      const result = await invoke<{
        eventCount: number;
        source: string;
        events: RecorderEvent[];
        sessionId: string;
      }>("recorder_stop", { sessionId: recordingSessionId });
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
    if (startingMacroRef.current || !activeProfile) return;
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

  return (
    <div className="adv-panel adv-panel-text macro-panel">
      <div className="adv-col">
        <div className="adv-sectioncontainer macro-main-card">
          <div className="adv-card-header macro-panel-header">
            <div className="macro-panel-title">
              <InfoIcon
                text={
                  settings.macroHotkeyOverride
                    ? `${primaryHotkey || "Clicker trigger"} runs the active macro.`
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
                disabled={
                  Boolean(recordingSessionId) ||
                  running ||
                  !settings.macroHotkeyOverride
                }
                onClick={() => setMacroEnabled(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={`adv-toggle-btn adv-toggle-on ${settings.macroHotkeyOverride ? "active" : ""}`}
                aria-pressed={settings.macroHotkeyOverride}
                disabled={
                  Boolean(recordingSessionId) ||
                  running ||
                  settings.macroHotkeyOverride
                }
                onClick={() => setMacroEnabled(true)}
              >
                On
              </button>
            </div>
          </div>
          <CardDivider />

          <div
            ref={macroContentRef}
            className={`macro-content ${settings.macroHotkeyOverride ? "" : "is-disabled"}`}
            aria-disabled={!settings.macroHotkeyOverride}
          >
            {recordingSessionId && (
              <div
                className="macro-recorder-warning"
                role="status"
                aria-live="polite"
              >
                Recording is active. Keyboard input is captured locally;
                password detection is best-effort.
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
                  disabled={
                    !settings.macroHotkeyOverride || Boolean(recordingSessionId)
                  }
                />
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={createMacro}
                  disabled={Boolean(recordingSessionId)}
                >
                  New
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={() => saveDraft()}
                >
                  Save
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={duplicateMacro}
                  disabled={!activeProfile || Boolean(recordingSessionId)}
                >
                  Duplicate
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={deleteMacro}
                  disabled={
                    !activeProfile ||
                    settings.macroProfiles.length <= 1 ||
                    Boolean(recordingSessionId)
                  }
                >
                  Delete
                </button>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={importMacro}
                  disabled={Boolean(recordingSessionId)}
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
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={() => {
                      if (activeProfile && draftName !== activeProfile.name) {
                        updateProfile(settings, update, activeProfile, {
                          name: draftName.trim().slice(0, 80) || "New Macro",
                        });
                      }
                    }}
                  />
                </label>
                <label className="macro-target">
                  <span>Target Window</span>
                  <AdvDropdown
                    className="macro-target-dropdown"
                    portalClassName="macro-dropdown-menu"
                    ariaLabel="Target Window"
                    value={selectedTarget ? String(selectedTarget.hwnd) : ""}
                    options={[
                      { value: "", label: "Select a window…" },
                      ...targets.map((target) => ({
                        value: String(target.hwnd),
                        label: `${target.title} — ${target.processName} (PID ${target.pid})`,
                      })),
                    ]}
                    hoverWheel={false}
                    disabled={!settings.macroHotkeyOverride}
                    onChange={(hwnd) => void chooseTarget(hwnd)}
                  />
                </label>
                <button
                  className="adv-secondary-btn macro-button"
                  onClick={() => void refreshTargets()}
                >
                  Refresh
                </button>
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
                    disabled={!settings.macroHotkeyOverride}
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
                        ? "Right-click each location; press Esc or turn Pick Point off to finish."
                        : "Pick coordinates to add move and click steps to the script."}
                    </small>
                  </div>
                  <button
                    className={`adv-secondary-btn macro-button ${pickCoordinateActive ? "macro-button-primary" : ""}`}
                    aria-pressed={pickCoordinateActive}
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
                <details className="macro-reference">
                  <summary>Command guide and examples</summary>
                  <div>
                    <code>
                      target process="app.exe" title_contains="Window"
                    </code>
                    <code>mode foreground</code>
                    <code>move x=200 y=150 space=screen duration=100ms</code>
                    <code>click button=left x=200 y=150 count=1 radius=0</code>
                    <code>
                      wait 250ms · repeat 3 {"{ … }"} · if ready == true{" "}
                      {"{ … }"}
                    </code>
                    <code>key_down "CTRL" · press "CTRL+A" · type "Hello"</code>
                    <code># Scripts are local; import never runs a macro.</code>
                  </div>
                </details>
              </section>
            )}

            {view === "record" && (
              <section className="macro-record-view">
                <div className="macro-recorder-warning">
                  Recording captures local keyboard and mouse actions only while
                  active. Keyboard presses and releases are recorded
                  automatically. Raw key names can reveal typed content;
                  password detection is best-effort. Avoid sensitive input.
                </div>
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
                      disabled={
                        Boolean(recordingSessionId) ||
                        recordingCountdown !== null
                      }
                    />
                    <span>seconds</span>
                  </label>
                  <span className="macro-recorder-feature">
                    Keyboard capture on
                  </span>
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
                    disabled={
                      !settings.macroHotkeyOverride ||
                      Boolean(recordingSessionId) ||
                      recordingCountdown !== null
                    }
                    onChange={(mode) => {
                      const enabled = mode === "all-movement";
                      setRecordCursorMovement(enabled);
                      update({ recordCursorMovement: enabled });
                    }}
                  />
                  <small>
                    Drag mode records paths while holding the left, middle, or
                    right mouse button. The other mode also captures free cursor
                    movement; clicks, scrolling, and keyboard actions are always
                    recorded.
                  </small>
                </label>
                <div className="macro-hotkey-settings">
                  <label>
                    <span>Record hotkey</span>
                    <input
                      aria-label="Recording hotkey"
                      value={settings.recordingHotkey}
                      onChange={(event) =>
                        update({ recordingHotkey: event.target.value })
                      }
                      disabled={
                        Boolean(recordingSessionId) ||
                        recordingCountdown !== null
                      }
                    />
                  </label>
                  <label>
                    <span>Emergency stop</span>
                    <input
                      aria-label="Emergency stop hotkey"
                      value={settings.emergencyStopHotkey}
                      onChange={(event) =>
                        update({ emergencyStopHotkey: event.target.value })
                      }
                      disabled={
                        Boolean(recordingSessionId) ||
                        recordingCountdown !== null
                      }
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
                      disabled={runtimeState === "Recording"}
                      onClick={beginRecordingCountdown}
                    >
                      Start Recording
                    </button>
                  )}
                  <span
                    className="macro-state-pill"
                    data-state={
                      recordingSessionId
                        ? "Recording"
                        : recordingCountdown !== null
                          ? "Countdown"
                          : runtimeState
                    }
                  >
                    {recordingSessionId
                      ? "Recording"
                      : recordingCountdown !== null
                        ? "Starting in " + recordingCountdown + "s"
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
                      disabled={Boolean(recordingSessionId) || !activeProfile}
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
    </div>
  );
}
