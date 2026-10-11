import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { error } from "@tauri-apps/plugin-log";
import { getKeyboardLayoutMap } from "../hotkeys";

export function useKeyboardLayoutMap() {
  const [layoutMap, setLayoutMap] =
    useState<Awaited<ReturnType<typeof getKeyboardLayoutMap>>>(null);

  useEffect(() => {
    let active = true;
    getKeyboardLayoutMap().then((map) => {
      if (active) setLayoutMap(map);
    });
    return () => {
      active = false;
    };
  }, []);

  return layoutMap;
}

export function useHotkeyCaptureSession(active: boolean, source: string) {
  useEffect(() => {
    if (!active) return;

    invoke("set_hotkey_capture_active", { active: true }).catch((err) => {
      error(JSON.stringify({ source: `${source}.start`, error: String(err) }));
    });

    return () => {
      invoke("set_hotkey_capture_active", { active: false }).catch((err) => {
        error(JSON.stringify({ source: `${source}.stop`, error: String(err) }));
      });
    };
  }, [active, source]);
}
