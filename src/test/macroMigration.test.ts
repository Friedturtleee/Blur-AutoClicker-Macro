import { describe, expect, it } from "vitest";
import {
  createDefaultSettings,
  createPresetDefinition,
} from "../settingsSchema";
import {
  legacyClickPointsToSource,
  migrateLegacyMacroProfiles,
} from "../macro/migration";

describe("Click Points to Macro migration", () => {
  it("preserves ordered coordinates, radius, repeats, cadence, and looping", () => {
    const settings = {
      ...createDefaultSettings("3.9.6"),
      clickPoints: [
        { id: "one", x: -120, y: 45, clicks: 2, radius: 7 },
        { id: "two", x: 900, y: 700, clicks: 3, radius: 0 },
      ],
      clickSpeed: 4,
      stopWhenComplete: false,
    };
    const source = legacyClickPointsToSource(settings);
    expect(source).toContain("while true {");
    expect(source).toContain("move x=-120 y=45 space=screen");
    expect(source).toContain("repeat 2 {");
    expect(source).toContain("button=left radius=7");
    expect(source).toContain("wait 250ms");
    expect(source.indexOf("move x=-120")).toBeLessThan(
      source.indexOf("move x=900"),
    );
  });

  it("keeps a one-pass macro when stopWhenComplete is enabled", () => {
    const settings = {
      ...createDefaultSettings("3.9.6"),
      clickPoints: [{ id: "one", x: 20, y: 30, clicks: 1, radius: 4 }],
      stopWhenComplete: true,
    };
    const source = legacyClickPointsToSource(settings);
    expect(source).not.toContain("while true");
    expect(source).toContain("radius=4");
  });

  it("creates a starter macro for an empty installation and is idempotent", () => {
    const settings = createDefaultSettings("3.9.6");
    const first = migrateLegacyMacroProfiles(
      settings,
      "2026-10-09T00:00:00.000Z",
    );
    expect(first.changed).toBe(true);
    expect(first.profiles[0].source).toContain("click button=left");
    const next = {
      ...settings,
      macroProfiles: first.profiles,
      activeMacroId: first.activeMacroId,
      macroMigrationVersion: 1,
    };
    expect(migrateLegacyMacroProfiles(next).changed).toBe(false);
  });

  it("converts old preset sequences without deleting their source settings", () => {
    const base = createDefaultSettings("3.9.6");
    const legacySettings = {
      ...base,
      clickPoints: [{ id: "old", x: 4, y: 5, clicks: 5, radius: 12 }],
    };
    const preset = createPresetDefinition("Legacy points", legacySettings);
    const settings = {
      ...base,
      presets: [preset],
      clickPoints: [],
    };
    const migrated = migrateLegacyMacroProfiles(
      settings,
      "2026-10-09T00:00:00.000Z",
    );
    const profile = migrated.profiles.find(
      (candidate) => candidate.sourcePresetId === preset.id,
    );
    expect(profile?.source).toContain("repeat 5 {");
    expect(profile?.source).toContain("radius=12");
    expect(preset.settings.clickPoints).toHaveLength(1);
  });
});
