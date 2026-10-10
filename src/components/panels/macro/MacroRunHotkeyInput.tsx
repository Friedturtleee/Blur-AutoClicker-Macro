import { type FocusEvent, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import HotkeyCaptureInput from "../../HotkeyCaptureInput";

interface HotkeyConflict {
  label: string;
  value: string;
}

interface Props {
  value: string;
  conflicts: HotkeyConflict[];
  disabled?: boolean;
  onChange: (value: string) => void;
}

const TOKEN_ALIASES: Record<string, string> = {
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
      return TOKEN_ALIASES[normalized] ?? normalized;
    })
    .filter(Boolean)
    .sort()
    .join("+");
}

export default function MacroRunHotkeyInput({
  value,
  conflicts,
  disabled = false,
  onChange,
}: Props) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const manualInputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (focusedRef.current) {
        void invoke("set_hotkey_capture_active", { active: false });
      }
    },
    [],
  );

  const commit = async (raw: string) => {
    try {
      const normalized = await invoke<string>("normalize_hotkey_input", {
        hotkey: raw,
      });
      const matchingConflict = conflicts.find(
        (conflict) =>
          conflict.value &&
          hotkeyIdentity(conflict.value) === hotkeyIdentity(normalized),
      );
      if (matchingConflict) {
        setError(`Already assigned to ${matchingConflict.label}.`);
        setDraft(raw);
        return;
      }

      setError("");
      setDraft(normalized);
      onChange(normalized);
    } catch (reason) {
      setError(String(reason));
      setDraft(raw);
    }
  };

  const conflictLabels = conflicts
    .filter(
      (conflict) =>
        conflict.value &&
        hotkeyIdentity(conflict.value) === hotkeyIdentity(value),
    )
    .map((conflict) => conflict.label);

  const handleFocus = () => {
    focusedRef.current = true;
    void invoke("set_hotkey_capture_active", { active: true });
    void invoke("stop_clicker");
  };

  const handleBlur = async (event: FocusEvent<HTMLInputElement>) => {
    const nextTarget = event.relatedTarget;
    const handingOffToCapture =
      nextTarget instanceof HTMLElement &&
      nextTarget.classList.contains("hk-button");
    const shouldCommit = !skipBlurCommitRef.current && !handingOffToCapture;
    skipBlurCommitRef.current = false;
    focusedRef.current = false;
    if (handingOffToCapture) {
      setDraft(value);
      setError("");
    }
    if (shouldCommit) await commit(draft);
    if (!handingOffToCapture) {
      void invoke("set_hotkey_capture_active", { active: false });
    }
  };

  const handleCapture = (captured: string) => {
    void commit(captured);
  };

  return (
    <div className={`macro-run-hotkey${disabled ? " is-disabled" : ""}`}>
      <label className="macro-run-hotkey-label">
        <span>Macro Hot Key</span>
        <input
          ref={manualInputRef}
          className="macro-run-hotkey-manual"
          aria-label="Macro run hotkey text"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          disabled={disabled}
          placeholder="e.g. ctrl+shift+m"
          onFocus={handleFocus}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
          onBlur={(event) => void handleBlur(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              manualInputRef.current?.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              skipBlurCommitRef.current = true;
              setDraft(value);
              manualInputRef.current?.blur();
            }
          }}
        />
      </label>
      <HotkeyCaptureInput
        value={value}
        onChange={handleCapture}
        className="settings-keybind-capture macro-run-hotkey-capture"
        conflicts={conflictLabels}
        editable={!disabled}
      />
      <small
        className={error ? "has-error" : ""}
        role={error ? "alert" : undefined}
      >
        {error ||
          "Requires Macro On. Press keys to capture or type a hotkey; leave blank to disable."}
      </small>
    </div>
  );
}
