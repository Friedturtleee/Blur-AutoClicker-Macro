import type { Settings } from "../../../../store";
import KeyCaptureInput from "../../../KeyCaptureInput";
import { SettingsCard } from "./shared";

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const PAGES = [
  { key: "keybindSimple" as const, label: "Simple" },
  { key: "keybindAdvanced" as const, label: "Advanced" },
  { key: "keybindZones" as const, label: "Zones" },
  { key: "keybindClickPoints" as const, label: "Macro" },
  { key: "keybindSettings" as const, label: "Settings" },
];

const TOGGLE_GROUPS: {
  title: string;
  items: { key: keyof Settings; label: string; sublabel: string }[];
}[] = [
  {
    title: "Advanced",
    items: [
      {
        key: "keybindMode",
        label: "Click Mode",
        sublabel: "Cycle Toggle / Hold.",
      },
      {
        key: "keybindInputType",
        label: "Input Type",
        sublabel: "Cycle Mouse / Keyboard.",
      },
      {
        key: "keybindDoubleClick",
        label: "Double Click",
        sublabel: "Toggle on or off.",
      },
      {
        key: "keybindDutyCycleMode",
        label: "Duty Cycle",
        sublabel: "Cycle Click / Hold.",
      },
      {
        key: "keybindSpeedRandomization",
        label: "Speed Randomization",
        sublabel: "Toggle on or off.",
      },
      {
        key: "keybindLimits",
        label: "Limits",
        sublabel: "Toggle the active click/time limit.",
      },
    ],
  },
  {
    title: "Zones",
    items: [
      {
        key: "keybindCornerStop",
        label: "Corner Stop",
        sublabel: "Toggle on or off.",
      },
      {
        key: "keybindEdgeStop",
        label: "Edge Stop",
        sublabel: "Toggle on or off.",
      },
      {
        key: "keybindStopZones",
        label: "Custom Stop Zones",
        sublabel: "Toggle on or off.",
      },
    ],
  },
  {
    title: "Macro",
    items: [
      {
        key: "keybindToggleClickPoints",
        label: "Macro",
        sublabel: "Toggle on or off.",
      },
      {
        key: "keybindStopWhenComplete",
        label: "Stop When Complete",
        sublabel: "Toggle on or off.",
      },
    ],
  },
];

export default function KeybindsSection({ settings, update }: Props) {
  return (
    <>
      <SettingsCard
        title="Master Switch"
        description="Bind a key that globally enables or disables the autoclicker. When off, the main activation keybind will not start it. Empty by default (always allowed)."
      >
        <div className="settings-row">
          <div className="settings-label-group">
            <span className="settings-label">Master Key</span>
            <span className="settings-sublabel">
              Toggle disables/enables on press. Hold keeps it enabled while
              held.
            </span>
          </div>
          <KeyCaptureInput
            className="settings-keybind-capture"
            value={settings.keybindMaster}
            onChange={(key) => update({ keybindMaster: key })}
          />
        </div>
        <div className="settings-row">
          <div className="settings-label-group">
            <span className="settings-label">Master Key Mode</span>
            <span className="settings-sublabel">
              Toggle: press to flip. Hold: autoclicker runs only while held.
            </span>
          </div>
          <div className="settings-seg-group">
            <button
              type="button"
              className={`settings-seg-btn ${settings.masterKeybindMode === "toggle" ? "active" : ""}`}
              onClick={() => update({ masterKeybindMode: "toggle" })}
            >
              Toggle
            </button>
            <button
              type="button"
              className={`settings-seg-btn ${settings.masterKeybindMode === "hold" ? "active" : ""}`}
              onClick={() => update({ masterKeybindMode: "hold" })}
            >
              Hold
            </button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Keybinds"
        description="Set a keyboard shortcut for each page. Press the key you want to bind."
      >
        {PAGES.map((page) => (
          <div className="settings-row" key={page.key}>
            <div className="settings-label-group">
              <span className="settings-label">{page.label}</span>
              <span className="settings-sublabel">
                Switch to the {page.label} page.
              </span>
            </div>
            <KeyCaptureInput
              className="settings-keybind-capture"
              value={settings[page.key]}
              onChange={(key) => update({ [page.key]: key })}
            />
          </div>
        ))}
      </SettingsCard>

      {TOGGLE_GROUPS.map((group) => (
        <SettingsCard
          key={group.title}
          title={`${group.title} Toggle Keybinds`}
          description="Bind a key to flip a setting from anywhere in the app. Empty by default."
        >
          {group.items.map((item) => (
            <div className="settings-row" key={item.key}>
              <div className="settings-label-group">
                <span className="settings-label">{item.label}</span>
                <span className="settings-sublabel">{item.sublabel}</span>
              </div>
              <KeyCaptureInput
                className="settings-keybind-capture"
                value={settings[item.key] as string}
                onChange={(key) => update({ [item.key]: key })}
              />
            </div>
          ))}
        </SettingsCard>
      ))}
    </>
  );
}
