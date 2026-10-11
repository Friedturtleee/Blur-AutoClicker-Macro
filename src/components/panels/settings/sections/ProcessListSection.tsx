import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../../../../store";
import { Disableable, CardDivider } from "../../advanced/sections/shared";
import { SettingsCard } from "./shared";

interface ProcessInfo {
  name: string;
  displayName: string;
  pid: number;
  iconBase64?: string;
}

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const PROCESS_REFRESH_INTERVAL_MS = 5_000;

function sameProcessSnapshot(left: ProcessInfo[], right: ProcessInfo[]) {
  return (
    left.length === right.length &&
    left.every((process, index) => {
      const next = right[index];
      return (
        process.name === next.name &&
        process.displayName === next.displayName &&
        process.pid === next.pid &&
        process.iconBase64 === next.iconBase64
      );
    })
  );
}

export default function ProcessListSection({ settings, update }: Props) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [listAtBottom, setListAtBottom] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const processListEntriesRef = useRef(settings.processListEntries);

  useLayoutEffect(() => {
    processListEntriesRef.current = settings.processListEntries;
  }, [settings.processListEntries]);

  const updateListAtBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setListAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  }, []);

  const handleListScroll = useCallback(() => {
    updateListAtBottom();
  }, [updateListAtBottom]);

  const silentRefresh = useCallback(async () => {
    if (
      !mountedRef.current ||
      document.visibilityState === "hidden" ||
      refreshInFlightRef.current
    ) {
      return;
    }
    refreshInFlightRef.current = true;
    const requestId = ++refreshRequestIdRef.current;
    try {
      const procs = await invoke<ProcessInfo[]>("list_processes");
      if (mountedRef.current && requestId === refreshRequestIdRef.current) {
        setProcesses((current) =>
          sameProcessSnapshot(current, procs) ? current : procs,
        );
      }
    } catch {
      // Keep the last snapshot; the next visible poll retries the request.
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        refreshInFlightRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void silentRefresh();
    };

    const initialRefreshTimer = window.setTimeout(() => {
      void silentRefresh();
    }, 0);
    intervalRef.current = setInterval(
      silentRefresh,
      PROCESS_REFRESH_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      mountedRef.current = false;
      refreshRequestIdRef.current += 1;
      refreshInFlightRef.current = false;
      window.clearTimeout(initialRefreshTimer);
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [silentRefresh]);

  useEffect(() => {
    updateListAtBottom();
  }, [processes, searchQuery, updateListAtBottom]);

  const toggleEntry = useCallback(
    (name: string, checked: boolean) => {
      const withoutName = processListEntriesRef.current.filter(
        (e) => e.name !== name,
      );
      const next = checked
        ? [
            ...withoutName,
            {
              name,
              enabled: true,
            },
          ]
        : withoutName;
      update({ processListEntries: next });
    },
    [update],
  );

  const normalizedSearchQuery = searchQuery.toLowerCase();
  const entryMap = useMemo(
    () =>
      new Map(
        settings.processListEntries.map(
          (entry) => [entry.name, entry] as const,
        ),
      ),
    [settings.processListEntries],
  );
  const { checkedProcesses, uncheckedProcesses } = useMemo(() => {
    const checked: ProcessInfo[] = [];
    const unchecked: ProcessInfo[] = [];

    for (const process of processes) {
      if (
        normalizedSearchQuery &&
        !process.displayName.toLowerCase().includes(normalizedSearchQuery) &&
        !process.name.toLowerCase().includes(normalizedSearchQuery)
      ) {
        continue;
      }
      (entryMap.get(process.name)?.enabled ? checked : unchecked).push(process);
    }

    return { checkedProcesses: checked, uncheckedProcesses: unchecked };
  }, [entryMap, normalizedSearchQuery, processes]);

  return (
    <SettingsCard
      title="Process List"
      description="Stop clicking when specific applications are in focus."
    >
      <div className="settings-row">
        <div className="settings-label-group">
          <span className="settings-label">Enable</span>
          <span className="settings-sublabel">
            Stop clicking based on the active application.
          </span>
        </div>
        <div className="settings-toggle-wrapper">
          <button
            className={`settings-toggle ${settings.processListEnabled ? "on" : "off"}`}
            onClick={() =>
              update({ processListEnabled: !settings.processListEnabled })
            }
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-label-group">
          <span className="settings-label">Mode</span>
          <span className="settings-sublabel">
            Whitelist only allows checked apps. Blacklist blocks them.
          </span>
        </div>
        <div className="settings-seg-group">
          <button
            type="button"
            className={`settings-seg-btn ${settings.processListMode === "whitelist" ? "active" : ""}`}
            onClick={() => update({ processListMode: "whitelist" })}
          >
            Whitelist
          </button>
          <button
            type="button"
            className={`settings-seg-btn ${settings.processListMode === "blacklist" ? "active" : ""}`}
            onClick={() => update({ processListMode: "blacklist" })}
          >
            Blacklist
          </button>
        </div>
      </div>

      <CardDivider />

      <Disableable
        enabled={settings.processListEnabled}
        disabledReason="Enable Process List to manage application rules."
      >
        {settings.processListMode === "whitelist" &&
        settings.processListEntries.length === 0 ? (
          <div className="settings-whitelist-warning">
            Whitelist mode is active with no applications selected. Clicking
            will be blocked everywhere.
          </div>
        ) : null}

        <div className="settings-proc-search-row">
          <input
            type="text"
            className="settings-proc-search"
            placeholder={`search in ${processes.length} applications`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            className="settings-proc-list"
            ref={listRef}
            onScroll={handleListScroll}
          >
            {loading ? (
              <div className="adv-click-points-empty">Refreshing...</div>
            ) : processes.length === 0 ? (
              <div className="adv-click-points-empty">No processes found.</div>
            ) : searchQuery.length >= 1 &&
              checkedProcesses.length === 0 &&
              uncheckedProcesses.length === 0 ? (
              <div
                className="adv-click-points-empty"
                style={{ textAlign: "center", padding: "1rem" }}
              >
                no process named &quot;{searchQuery}&quot;
              </div>
            ) : (
              <>
                {checkedProcesses.map((proc) => (
                  <ProcessRow
                    key={proc.name}
                    proc={proc}
                    checked
                    onToggleEntry={toggleEntry}
                  />
                ))}
                {checkedProcesses.length > 0 &&
                  uncheckedProcesses.length > 0 && (
                    <div
                      style={{
                        height: 1,
                        background: "var(--border-subtle)",
                        margin: "0.25rem 0",
                      }}
                    />
                  )}
                {uncheckedProcesses.map((proc) => (
                  <ProcessRow
                    key={proc.name}
                    proc={proc}
                    checked={false}
                    onToggleEntry={toggleEntry}
                  />
                ))}
              </>
            )}
          </div>
          <div
            className={`settings-proc-fade ${listAtBottom ? "settings-proc-fade--hidden" : ""}`}
          />
        </div>
      </Disableable>
    </SettingsCard>
  );
}

const ProcessRow = memo(function ProcessRow({
  proc,
  checked,
  onToggleEntry,
}: {
  proc: ProcessInfo;
  checked: boolean;
  onToggleEntry: (name: string, checked: boolean) => void;
}) {
  return (
    <label className="adv-click-points-item">
      <input
        type="checkbox"
        className="settings-proc-checkbox"
        checked={checked}
        onChange={(e) => onToggleEntry(proc.name, e.target.checked)}
      />
      {proc.iconBase64 ? (
        <img src={proc.iconBase64} alt="" className="settings-proc-icon" />
      ) : null}
      <span className="settings-proc-name">{proc.displayName}</span>
      <span className="settings-proc-exe">{proc.name}</span>
    </label>
  );
});
