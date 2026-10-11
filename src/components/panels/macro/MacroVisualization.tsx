import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  buildMacroVisualization,
  type CoordinateSpace,
  type MacroVisualAction,
} from "../../../macro/visualization";

interface Props {
  source: string;
}

const ACTION_PAGE_SIZE = 50;
const MAP_MARKER_LIMIT = 500;
const MAP_TRAJECTORY_POINT_LIMIT = 1_200;

function actionLabel(action: MacroVisualAction) {
  const coordinates =
    action.x === undefined || action.y === undefined
      ? "position not fixed"
      : `${action.x}, ${action.y} · ${action.space}`;
  const repeats = action.repetitions > 1 ? ` ×${action.repetitions}` : "";

  switch (action.kind) {
    case "move":
      return `Move → ${coordinates}${repeats}`;
    case "click":
      return `Click ${action.button} · ${coordinates} · ${action.count ?? 1} clicks${action.radius ? ` · radius ${action.radius}` : ""}`;
    case "scroll":
      return `Scroll ${action.delta === 0 ? "·" : action.delta! > 0 ? "↑" : "↓"} · ${coordinates}${repeats}`;
  }
}

const MacroVisualization = memo(function MacroVisualization({ source }: Props) {
  const [actionPageState, setActionPageState] = useState({ source, page: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isTogglingFullscreen, setIsTogglingFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [isTransparent, setIsTransparent] = useState(false);
  const [mapSpace, setMapSpace] = useState<CoordinateSpace>("screen");
  const [displayScale, setDisplayScale] = useState(1);
  const fullscreenToggleRef = useRef(false);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const previousFullscreenRef = useRef(isFullscreen);
  const mountedRef = useRef(true);
  const mapSvgRef = useRef<SVGSVGElement>(null);
  const visualizationSource = useDeferredValue(source);
  const visualization = useMemo(
    () => buildMacroVisualization(visualizationSource),
    [visualizationSource],
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (previousFullscreenRef.current === isFullscreen) return;
    previousFullscreenRef.current = isFullscreen;
    fullscreenButtonRef.current?.focus();
  }, [isFullscreen]);
  useEffect(() => {
    if (!isFullscreen) {
      setDisplayScale(1);
      return;
    }
    const element = mapSvgRef.current;
    if (!element) return;
    const updateScale = () => {
      const nextScale = Math.max(
        1,
        Math.min(element.clientWidth / 320, element.clientHeight / 168),
      );
      setDisplayScale((current) =>
        Math.abs(current - nextScale) < 0.01 ? current : nextScale,
      );
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(element);
    return () => observer.disconnect();
  }, [isFullscreen]);
  const mapUnit = (value: number) => value / displayScale;
  const actionPage =
    actionPageState.source === source ? actionPageState.page : 0;
  const actionPageCount = Math.max(
    1,
    Math.ceil(visualization.actions.length / ACTION_PAGE_SIZE),
  );
  const currentActionPage = Math.min(actionPage, actionPageCount - 1);
  const changeActionPage = (delta: number) => {
    setActionPageState((current) => {
      const page = current.source === source ? current.page : 0;
      return {
        source,
        page: Math.max(0, Math.min(page + delta, actionPageCount - 1)),
      };
    });
  };
  const visibleActions = visualization.actions.slice(
    currentActionPage * ACTION_PAGE_SIZE,
    (currentActionPage + 1) * ACTION_PAGE_SIZE,
  );
  const coordinateActions = useMemo(
    () =>
      visualization.actions.filter(
        (action) => action.x !== undefined && action.y !== undefined,
      ),
    [visualization.actions],
  );
  const coordinateSpaces = useMemo(
    () =>
      (["screen", "client"] as const).filter((space) =>
        coordinateActions.some((action) => action.space === space),
      ),
    [coordinateActions],
  );
  const activeMapSpace = coordinateSpaces.includes(mapSpace)
    ? mapSpace
    : (coordinateSpaces[0] ?? "screen");
  const mapSpaceActions = useMemo(
    () => coordinateActions.filter((action) => action.space === activeMapSpace),
    [activeMapSpace, coordinateActions],
  );
  const plottedMapActions = useMemo(
    () => mapSpaceActions.slice(0, MAP_MARKER_LIMIT),
    [mapSpaceActions],
  );
  const lastPlottedOrder =
    plottedMapActions[plottedMapActions.length - 1]?.order ?? 0;
  const plottedClickPoints = useMemo(
    () =>
      visualization.clickPoints
        .filter(
          (point) =>
            point.space === activeMapSpace &&
            point.firstOrder <= lastPlottedOrder,
        )
        .slice(0, MAP_MARKER_LIMIT),
    [activeMapSpace, lastPlottedOrder, visualization.clickPoints],
  );
  const mapGeometry = useMemo(() => {
    let minX = mapSpaceActions.length ? Number.POSITIVE_INFINITY : 0;
    let maxX = mapSpaceActions.length ? Number.NEGATIVE_INFINITY : 1;
    let minY = mapSpaceActions.length ? Number.POSITIVE_INFINITY : 0;
    let maxY = mapSpaceActions.length ? Number.NEGATIVE_INFINITY : 1;
    let pathPointCount = 0;
    const includePoint = (x: number, y: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };
    mapSpaceActions.forEach((action) => {
      includePoint(action.x!, action.y!);
      pathPointCount += 1;
      if (action.fromX !== undefined && action.fromY !== undefined) {
        includePoint(action.fromX, action.fromY);
        if (action.kind === "move") pathPointCount += 1;
      }
    });
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const coordinateScale = Math.min(
      spanX > 0 ? 284 / spanX : Number.POSITIVE_INFINITY,
      spanY > 0 ? 132 / spanY : Number.POSITIVE_INFINITY,
    );
    const mapRadiusScale = Number.isFinite(coordinateScale)
      ? coordinateScale
      : 1;
    const offsetX = 18 + (284 - spanX * mapRadiusScale) / 2;
    const offsetY = 18 + (132 - spanY * mapRadiusScale) / 2;
    const plot = (x: number, y: number) => ({
      x: spanX === 0 ? 160 : offsetX + (x - minX) * mapRadiusScale,
      y: spanY === 0 ? 84 : offsetY + (y - minY) * mapRadiusScale,
    });
    const pathPointStride = Math.max(
      1,
      Math.ceil(pathPointCount / MAP_TRAJECTORY_POINT_LIMIT),
    );
    const pathCoordinates: string[] = [];
    let pathPointIndex = 0;
    const appendTrajectoryPoint = (x: number, y: number) => {
      if (
        pathPointIndex % pathPointStride === 0 ||
        pathPointIndex === pathPointCount - 1
      ) {
        const point = plot(x, y);
        pathCoordinates.push(`${point.x},${point.y}`);
      }
      pathPointIndex += 1;
    };
    mapSpaceActions.forEach((action) => {
      if (
        action.kind === "move" &&
        action.fromX !== undefined &&
        action.fromY !== undefined
      ) {
        appendTrajectoryPoint(action.fromX, action.fromY);
      }
      appendTrajectoryPoint(action.x!, action.y!);
    });
    const trajectoryPoints = pathCoordinates.join(" ");
    return { plot, mapRadiusScale, trajectoryPoints };
  }, [mapSpaceActions]);
  const { plot, mapRadiusScale, trajectoryPoints } = mapGeometry;

  const toggleFullscreen = async () => {
    if (fullscreenToggleRef.current) return;
    fullscreenToggleRef.current = true;
    setIsTogglingFullscreen(true);
    try {
      const appWindow = getCurrentWindow();
      const nextFullscreen = !isFullscreen;
      await appWindow.setFullscreen(nextFullscreen);
      if (!mountedRef.current) {
        if (nextFullscreen) await appWindow.setFullscreen(false);
        return;
      }
      setIsFullscreen(nextFullscreen);
      setFullscreenError("");
    } catch (error) {
      console.error("Could not toggle Action Map fullscreen:", error);
      if (mountedRef.current)
        setFullscreenError(
          "Could not change fullscreen mode: " + String(error),
        );
    } finally {
      fullscreenToggleRef.current = false;
      if (mountedRef.current) setIsTogglingFullscreen(false);
    }
  };

  useEffect(() => {
    if (!isFullscreen) return;
    document.documentElement.classList.add("macro-map-fullscreen");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsFullscreen(false);
      void getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.documentElement.classList.remove("macro-map-fullscreen");
      void getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {});
    };
  }, [isFullscreen]);

  const visualizationContent = (
    <aside
      className={
        "macro-visualization" +
        (isFullscreen ? " macro-visualization-fullscreen" : "") +
        (isTransparent ? " is-transparent" : "")
      }
      aria-label="Macro action map"
    >
      <div className="macro-visualization-heading">
        <strong>Action map</strong>
        <span>
          {visualization.clickPoints.length} points ·{" "}
          {visualization.actions.length} actions
        </span>
        <button
          ref={fullscreenButtonRef}
          type="button"
          className="adv-secondary-btn macro-button macro-map-fullscreen-toggle"
          onClick={() => void toggleFullscreen()}
          disabled={isTogglingFullscreen}
          aria-busy={isTogglingFullscreen}
          aria-label={
            isFullscreen
              ? "Exit fullscreen action map"
              : "Show fullscreen action map"
          }
          title={isFullscreen ? "Exit fullscreen (Esc)" : "Show fullscreen"}
        >
          <svg
            className="macro-fullscreen-icon"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {isFullscreen ? (
              <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
            ) : (
              <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
            )}
          </svg>
          <span>{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
        </button>
      </div>
      {fullscreenError && (
        <div className="macro-map-error" role="alert">
          {fullscreenError}
        </div>
      )}
      {(coordinateSpaces.length > 0 || isFullscreen) && (
        <div className="macro-map-display-controls">
          {coordinateSpaces.length > 1 && (
            <div
              className="macro-map-space-options"
              role="group"
              aria-label="Coordinate space"
            >
              <span>View</span>
              {coordinateSpaces.map((space) => (
                <button
                  key={space}
                  type="button"
                  className="adv-secondary-btn macro-button macro-map-space-button"
                  aria-pressed={activeMapSpace === space}
                  onClick={() => setMapSpace(space)}
                >
                  {space === "screen" ? "Screen" : "Client"}
                </button>
              ))}
            </div>
          )}
          {coordinateSpaces.length === 1 && (
            <span className="macro-map-space-label">
              {activeMapSpace === "screen"
                ? "Screen coordinates"
                : "Client coordinates"}
            </span>
          )}
          {isFullscreen && (
            <>
              <span className="macro-map-display-summary">
                {coordinateSpaces.length > 0
                  ? `${activeMapSpace} route · ${mapSpaceActions.length} coordinate actions`
                  : "No coordinate actions"}
              </span>
              <button
                type="button"
                className="adv-secondary-btn macro-button"
                aria-pressed={isTransparent}
                onClick={() => setIsTransparent((current) => !current)}
              >
                {isTransparent ? "Transparent: On" : "Transparent: Off"}
              </button>
            </>
          )}
        </div>
      )}
      <svg
        ref={mapSvgRef}
        className="macro-action-map"
        viewBox="0 0 320 168"
        role="img"
        aria-label={`Coordinates and ordered macro actions in ${activeMapSpace} space, parsed from click, move, and scroll commands`}
      >
        <defs>
          <pattern
            id="macro-map-grid"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 24 0 L 0 0 0 24"
              className="macro-map-grid-line"
              vectorEffect="non-scaling-stroke"
            />
          </pattern>
          <marker
            id="macro-map-arrowhead"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
            markerWidth={mapUnit(5)}
            markerHeight={mapUnit(5)}
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="macro-map-arrowhead" />
          </marker>
        </defs>
        <rect
          x="0"
          y="0"
          width="320"
          height="168"
          rx="8"
          className="macro-map-background"
          vectorEffect="non-scaling-stroke"
        />
        <rect
          x="0"
          y="0"
          width="320"
          height="168"
          rx="8"
          fill="url(#macro-map-grid)"
        />
        {trajectoryPoints && (
          <polyline
            points={trajectoryPoints}
            className="macro-map-trajectory"
            markerEnd="url(#macro-map-arrowhead)"
          />
        )}
        {plottedMapActions.map((action) => {
          if (
            action.kind !== "move" ||
            action.x === undefined ||
            action.y === undefined
          ) {
            return null;
          }
          const end = plot(action.x, action.y);
          const start =
            action.fromX !== undefined && action.fromY !== undefined
              ? plot(action.fromX, action.fromY)
              : null;
          return (
            <g key={`move-${action.order}`}>
              {start &&
              (action.fromX !== action.x || action.fromY !== action.y) ? (
                <line
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  className="macro-map-move"
                  markerEnd="url(#macro-map-arrowhead)"
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <text
                  x={end.x}
                  y={end.y - mapUnit(7)}
                  className="macro-map-move-icon"
                  style={{
                    fontSize: mapUnit(8),
                    strokeWidth: mapUnit(2.5),
                  }}
                >
                  ↗
                </text>
              )}
              <text
                x={end.x + mapUnit(5)}
                y={end.y - mapUnit(5)}
                className="macro-map-move-number"
                style={{
                  fontSize: mapUnit(8),
                  strokeWidth: mapUnit(2.5),
                }}
              >
                {action.order}
              </text>
            </g>
          );
        })}
        {plottedClickPoints.map((point) => {
          const location = plot(point.x, point.y);
          return (
            <g
              key={`click-${point.space}-${point.x}-${point.y}-${point.button}-${point.radius}`}
            >
              <title>
                {`Action ${point.firstOrder}: ${point.clicks} ${point.button} click(s) at ${point.x}, ${point.y} (${point.space})${point.radius ? `, random radius ${point.radius}` : ""}`}
              </title>
              {point.radius > 0 && (
                <circle
                  cx={location.x}
                  cy={location.y}
                  r={Math.min(60, Math.max(7, point.radius * mapRadiusScale))}
                  className="macro-map-click-radius"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <circle
                cx={location.x}
                cy={location.y}
                r={mapUnit(7)}
                className="macro-map-click"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={location.x}
                y={location.y + mapUnit(3)}
                className="macro-map-point-number"
                style={{ fontSize: mapUnit(7) }}
              >
                {point.firstOrder}
              </text>
              {point.clicks > 1 && (
                <text
                  x={location.x + mapUnit(10)}
                  y={location.y - mapUnit(6)}
                  className="macro-map-count"
                  style={{
                    fontSize: mapUnit(7),
                    strokeWidth: mapUnit(2.5),
                  }}
                >
                  ×{point.clicks}
                </text>
              )}
            </g>
          );
        })}
        {plottedMapActions.map((action) => {
          if (
            action.kind !== "scroll" ||
            action.x === undefined ||
            action.y === undefined
          ) {
            return null;
          }
          const location = plot(action.x, action.y);
          const direction =
            action.delta === 0 ? "↕" : action.delta! > 0 ? "↑" : "↓";
          const badge = {
            x: Math.min(320 - mapUnit(18), location.x + mapUnit(11)),
            y: Math.max(mapUnit(10), location.y - mapUnit(10)),
          };
          return (
            <g key={`scroll-${action.order}`}>
              <title>{`Action ${action.order}: scroll ${direction}, delta ${action.delta}`}</title>
              <line
                x1={location.x}
                y1={location.y}
                x2={badge.x}
                y2={badge.y}
                className="macro-map-scroll-stem"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={badge.x}
                cy={badge.y}
                r={mapUnit(8)}
                className="macro-map-scroll"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={badge.x}
                y={badge.y + mapUnit(4)}
                className="macro-map-scroll-icon"
                style={{ fontSize: mapUnit(7) }}
              >
                {direction}
              </text>
              <text
                x={badge.x + mapUnit(9)}
                y={badge.y - mapUnit(5)}
                className="macro-map-count"
                style={{
                  fontSize: mapUnit(7),
                  strokeWidth: mapUnit(2.5),
                }}
              >
                {action.order}
                {action.repetitions > 1 ? ` ×${action.repetitions}` : ""}
              </text>
            </g>
          );
        })}
        {mapSpaceActions.length === 0 && (
          <text
            x="160"
            y="86"
            textAnchor="middle"
            className="macro-map-empty"
            style={{ fontSize: mapUnit(9) }}
          >
            Add numeric click, move, or scroll coordinates
          </text>
        )}
      </svg>
      {mapSpaceActions.length > MAP_MARKER_LIMIT && (
        <span className="macro-visualization-note">
          The route includes every {activeMapSpace} coordinate action; numbered
          markers show the first {MAP_MARKER_LIMIT}.
        </span>
      )}
      {visualization.actions.length > ACTION_PAGE_SIZE && (
        <div className="macro-visualization-pagination">
          <span>
            Actions {currentActionPage * ACTION_PAGE_SIZE + 1}–
            {Math.min(
              (currentActionPage + 1) * ACTION_PAGE_SIZE,
              visualization.actions.length,
            )}{" "}
            of {visualization.actions.length}
          </span>
          <button
            type="button"
            className="adv-secondary-btn macro-button"
            disabled={currentActionPage === 0}
            onClick={() => changeActionPage(-1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="adv-secondary-btn macro-button"
            disabled={currentActionPage >= actionPageCount - 1}
            onClick={() => changeActionPage(1)}
          >
            Next
          </button>
        </div>
      )}
      <ol
        className="macro-visualization-list"
        aria-label="Ordered macro actions"
      >
        {visibleActions.map((action) => (
          <li key={`${action.kind}-${action.order}`}>
            <span
              className={`macro-action-icon macro-action-icon--${action.kind}`}
              aria-hidden="true"
            >
              {action.kind === "move"
                ? "↗"
                : action.kind === "click"
                  ? "●"
                  : action.delta === 0
                    ? "↕"
                    : action.delta! > 0
                      ? "↑"
                      : "↓"}
            </span>
            <span className="macro-action-order">{action.order}.</span>
            <span className="macro-action-description">
              {actionLabel(action)}
            </span>
          </li>
        ))}
        {visualization.actions.length === 0 && (
          <li className="macro-visualization-empty">
            No coordinate actions yet.
          </li>
        )}
      </ol>
    </aside>
  );

  return isFullscreen
    ? createPortal(visualizationContent, document.body)
    : visualizationContent;
});

export default MacroVisualization;
