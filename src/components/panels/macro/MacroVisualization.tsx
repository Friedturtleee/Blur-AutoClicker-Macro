import { memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  buildMacroVisualization,
  type MacroVisualAction,
} from "../../../macro/visualization";

interface Props {
  source: string;
}

const ACTION_PAGE_SIZE = 50;
const MAP_MARKER_LIMIT = 500;

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
  const [isTransparent, setIsTransparent] = useState(false);
  const visualizationSource = useDeferredValue(source);
  const visualization = useMemo(
    () => buildMacroVisualization(visualizationSource),
    [visualizationSource],
  );
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
  const coordinateActions = visualization.actions.filter(
    (action) => action.x !== undefined && action.y !== undefined,
  );
  const plottedMapActions = visualization.actions.slice(0, MAP_MARKER_LIMIT);
  const plottedClickPoints = visualization.clickPoints
    .filter((point) => point.firstOrder <= MAP_MARKER_LIMIT)
    .slice(0, MAP_MARKER_LIMIT);
  const plottedActions = coordinateActions;
  let minX = plottedActions.length ? Number.POSITIVE_INFINITY : 0;
  let maxX = plottedActions.length ? Number.NEGATIVE_INFINITY : 1;
  let minY = plottedActions.length ? Number.POSITIVE_INFINITY : 0;
  let maxY = plottedActions.length ? Number.NEGATIVE_INFINITY : 1;
  const includePoint = (x: number, y: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  plottedActions.forEach((action) => {
    includePoint(action.x!, action.y!);
    if (action.fromX !== undefined && action.fromY !== undefined)
      includePoint(action.fromX, action.fromY);
  });
  const plot = (x: number, y: number) => ({
    x: 18 + ((x - minX) / Math.max(1, maxX - minX)) * 284,
    y: 18 + ((y - minY) / Math.max(1, maxY - minY)) * 132,
  });
  const mapRadiusScale = Math.min(
    maxX > minX ? 284 / (maxX - minX) : 1,
    maxY > minY ? 132 / (maxY - minY) : 1,
  );
  const trajectoryPoints = coordinateActions
    .flatMap((action) => {
      const start =
        action.kind === "move" &&
        action.fromX !== undefined &&
        action.fromY !== undefined
          ? [plot(action.fromX, action.fromY)]
          : [];
      return [...start, plot(action.x!, action.y!)];
    })
    .map((position) => {
      return `${position.x},${position.y}`;
    })
    .join(" ");

  const toggleFullscreen = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.setFullscreen(!isFullscreen);
      setIsFullscreen((current) => !current);
    } catch (error) {
      console.error("Could not toggle Action Map fullscreen:", error);
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
          type="button"
          className="adv-secondary-btn macro-button macro-map-fullscreen-toggle"
          onClick={() => void toggleFullscreen()}
          aria-label={
            isFullscreen
              ? "Exit fullscreen action map"
              : "Show fullscreen action map"
          }
          title={isFullscreen ? "Exit fullscreen (Esc)" : "Show fullscreen"}
        >
          {isFullscreen ? "Exit fullscreen" : "⛶ Fullscreen"}
        </button>
      </div>
      {isFullscreen && (
        <div className="macro-map-display-controls">
          <span>Full macro route · {visualization.actions.length} actions</span>
          <button
            type="button"
            className="adv-secondary-btn macro-button"
            aria-pressed={isTransparent}
            onClick={() => setIsTransparent((current) => !current)}
          >
            {isTransparent ? "Transparent: On" : "Transparent: Off"}
          </button>
        </div>
      )}
      <svg
        className="macro-action-map"
        viewBox="0 0 320 168"
        role="img"
        aria-label="Coordinates and ordered macro actions parsed from click, move, and scroll commands"
      >
        <defs>
          <pattern
            id="macro-map-grid"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <path d="M 24 0 L 0 0 0 24" className="macro-map-grid-line" />
          </pattern>
          <marker
            id="macro-map-arrowhead"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
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
            markerMid="url(#macro-map-arrowhead)"
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
                />
              ) : (
                <text x={end.x} y={end.y - 7} className="macro-map-move-icon">
                  ↗
                </text>
              )}
              <text
                x={end.x + 5}
                y={end.y - 5}
                className="macro-map-move-number"
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
                />
              )}
              <circle
                cx={location.x}
                cy={location.y}
                r="7"
                className="macro-map-click"
              />
              <text
                x={location.x}
                y={location.y + 3}
                className="macro-map-point-number"
              >
                {point.firstOrder}
              </text>
              {point.clicks > 1 && (
                <text
                  x={location.x + 10}
                  y={location.y - 6}
                  className="macro-map-count"
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
            x: Math.min(302, location.x + 11),
            y: Math.max(10, location.y - 10),
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
              />
              <circle
                cx={badge.x}
                cy={badge.y}
                r="8"
                className="macro-map-scroll"
              />
              <text
                x={badge.x}
                y={badge.y + 4}
                className="macro-map-scroll-icon"
              >
                {direction}
              </text>
              <text x={badge.x + 9} y={badge.y - 5} className="macro-map-count">
                {action.order}
                {action.repetitions > 1 ? ` ×${action.repetitions}` : ""}
              </text>
            </g>
          );
        })}
        {plottedActions.length === 0 && (
          <text x="160" y="86" textAnchor="middle" className="macro-map-empty">
            Add numeric click, move, or scroll coordinates
          </text>
        )}
      </svg>
      {visualization.actions.length > MAP_MARKER_LIMIT && (
        <span className="macro-visualization-note">
          The route includes every coordinate action; numbered markers show the
          first {MAP_MARKER_LIMIT}.
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
