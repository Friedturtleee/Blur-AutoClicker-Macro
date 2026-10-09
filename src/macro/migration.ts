import type { ClickPoint, PresetDefinition, Settings } from "../settingsSchema";
import type { MacroProfile } from "./types";

function createId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    "macro-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8)
  );
}

export function intervalForLegacyPoints(settings: {
  clickSpeed: number;
  clickInterval: string;
  rateInputMode: string;
  durationHours: number;
  durationMinutes: number;
  durationSeconds: number;
  durationMilliseconds: number;
}): number {
  if (settings.rateInputMode === "duration") {
    return Math.max(
      1,
      settings.durationHours * 3_600_000 +
        settings.durationMinutes * 60_000 +
        settings.durationSeconds * 1000 +
        settings.durationMilliseconds,
    );
  }
  const scale =
    settings.clickInterval === "m"
      ? 60
      : settings.clickInterval === "h"
        ? 3600
        : settings.clickInterval === "d"
          ? 86400
          : 1;
  return Math.max(
    1,
    Math.round((1000 * scale) / Math.max(0.001, settings.clickSpeed)),
  );
}

function pointLines(
  points: ClickPoint[],
  intervalMs: number,
  inputType: string,
  keyboardKey: string,
  mouseButton: string,
): string[] {
  const lines: string[] = [];
  for (const point of points) {
    lines.push(
      "  move x=" +
        Math.trunc(point.x) +
        " y=" +
        Math.trunc(point.y) +
        " space=screen",
    );
    const action =
      inputType === "keyboard" && keyboardKey.trim()
        ? "press " + JSON.stringify(keyboardKey.trim().toUpperCase())
        : "click button=" +
          mouseButton.toLowerCase() +
          " radius=" +
          Math.max(0, Math.trunc(point.radius));
    if (inputType === "keyboard" && !keyboardKey.trim()) {
      lines.push(
        "  # Legacy keyboard key was empty; this point is kept as a mouse click.",
      );
    }
    lines.push("  repeat " + Math.max(1, Math.trunc(point.clicks)) + " {");
    lines.push("    " + action);
    lines.push("    wait " + intervalMs + "ms");
    lines.push("  }");
  }
  return lines;
}

export function legacyClickPointsToSource(settings: {
  clickPoints: ClickPoint[];
  stopWhenComplete: boolean;
  clickSpeed: number;
  clickInterval: string;
  rateInputMode: string;
  durationHours: number;
  durationMinutes: number;
  durationSeconds: number;
  durationMilliseconds: number;
  inputType: string;
  keyboardKey: string;
  mouseButton: string;
}): string {
  const lines = [
    "mode foreground",
    "# Converted from a saved Click Points sequence. Review before replay.",
  ];
  const body = pointLines(
    settings.clickPoints,
    intervalForLegacyPoints(settings),
    settings.inputType,
    settings.keyboardKey,
    settings.mouseButton,
  );
  if (settings.stopWhenComplete) {
    lines.push(...body);
  } else {
    lines.push("while true {", ...body, "}");
  }
  return lines.join("\n");
}

export function migrateLegacyMacroProfiles(
  settings: Settings,
  now = new Date().toISOString(),
): {
  profiles: MacroProfile[];
  activeMacroId: string | null;
  changed: boolean;
} {
  if (
    settings.macroMigrationVersion >= 1 &&
    settings.macroProfiles.length > 0
  ) {
    return {
      profiles: settings.macroProfiles,
      activeMacroId: settings.activeMacroId,
      changed: false,
    };
  }

  const profiles = [...settings.macroProfiles];
  const profileForPreset = new Map<string, MacroProfile>();
  for (const preset of settings.presets) {
    if (preset.settings.clickPoints.length === 0) continue;
    const profile: MacroProfile = {
      id: createId(),
      name: (preset.name + " (Macro)").slice(0, 80),
      source: legacyClickPointsToSource({
        ...preset.settings,
        rateInputMode: settings.rateInputMode,
        durationHours: settings.durationHours,
        durationMinutes: settings.durationMinutes,
        durationSeconds: settings.durationSeconds,
        durationMilliseconds: settings.durationMilliseconds,
      }),
      syntaxVersion: 1,
      target: null,
      createdAt: now,
      updatedAt: now,
      sourcePresetId: preset.id,
    };
    profiles.push(profile);
    profileForPreset.set(preset.id, profile);
  }

  let activeMacroId = settings.activeMacroId;
  if (settings.clickPoints.length > 0) {
    const alreadyMigrated = settings.activePresetId
      ? profileForPreset.get(settings.activePresetId)
      : undefined;
    const profile =
      alreadyMigrated ??
      ({
        id: createId(),
        name: "Imported Click Points",
        source: legacyClickPointsToSource(settings),
        syntaxVersion: 1,
        target: null,
        createdAt: now,
        updatedAt: now,
        ...(settings.activePresetId
          ? { sourcePresetId: settings.activePresetId }
          : {}),
      } satisfies MacroProfile);
    if (!alreadyMigrated) profiles.push(profile);
    activeMacroId = profile.id;
  } else if (
    activeMacroId &&
    !profiles.some((profile) => profile.id === activeMacroId)
  ) {
    activeMacroId = null;
  }

  if (profiles.length === 0) {
    const starter: MacroProfile = {
      id: createId(),
      name: "Starter Macro",
      source: [
        "mode foreground",
        "# Move the pointer where you want the action, then run this example.",
        "click button=left count=1 radius=0",
        "wait 1s",
      ].join("\n"),
      syntaxVersion: 1,
      target: null,
      createdAt: now,
      updatedAt: now,
    };
    profiles.push(starter);
    activeMacroId = starter.id;
  } else if (!activeMacroId) {
    activeMacroId = profiles[0].id;
  }

  return { profiles, activeMacroId, changed: true };
}

export function migrationPresetFixture(
  settings: Settings,
  preset: PresetDefinition,
): string {
  return legacyClickPointsToSource({
    ...preset.settings,
    rateInputMode: settings.rateInputMode,
    durationHours: settings.durationHours,
    durationMinutes: settings.durationMinutes,
    durationSeconds: settings.durationSeconds,
    durationMilliseconds: settings.durationMilliseconds,
  });
}
