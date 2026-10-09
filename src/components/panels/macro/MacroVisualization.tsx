import { useMemo } from "react";
import {
  buildMacroVisualization,
  type MacroVisualAction,
} from "../../../macro/visualization";

interface Props {
  source: string;
}

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
      return `Click ${action.button} · ${coordinates} · ${action.count ?? 1} clicks`;
    case "scroll":
      return `Scroll ${action.delta === 0 ? "·" : action.delta! > 0 ? "↑" : "↓"} · ${coordinates}${repeats}`;
  }
}

export default function MacroVisualization({ source }: Props) {
  const visualization = useMemo(
    () => buildMacroVisualization(source),
    [source],
  );
  const plottedActions = visualization.actions.filter(
    (action) => action.x !== undefined && action.y !== undefined,
  );
  const coordinates = plottedActions.flatMap((action) => [
    { x: action.x!, y: action.y! },
    ...(action.fromX !== undefined && action.fromY !== undefined
      ? [{ x: action.fromX, y: action.fromY }]
      : []),
  ]);
  const minX = coordinates.length
    ? Math.min(...coordinates.map((point) => point.x))
    : 0;
  const maxX = coordinates.length
    ? Math.max(...coordinates.map((point) => point.x))
    : 1;
  const minY = coordinates.length
    ? Math.min(...coordinates.map((point) => point.y))
    : 0;
  const maxY = coordinates.length
    ? Math.max(...coordinates.map((point) => point.y))
    : 1;
  const plot = (x: number, y: number) => ({
    x: 18 + ((x - minX) / Math.max(1, maxX - minX)) * 284,
    y: 18 + ((y - minY) / Math.max(1, maxY - minY)) * 132,
  });

  return (
    <aside className="macro-visualization" aria-label="Macro action map">
      <div className="macro-visualization-heading">
        <strong>Action map</strong>
        <span>
          {visualization.clickPoints.length} points ·{" "}
          {visualization.actions.length} actions
        </span>
      </div>
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
        {visualization.actions.map((action) => {
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
        {visualization.clickPoints.map((point) => {
          const location = plot(point.x, point.y);
          return (
            <g
              key={`click-${point.space}-${point.x}-${point.y}-${point.button}`}
            >
              <title>
                {`Action ${point.firstOrder}: ${point.clicks} ${point.button} click(s) at ${point.x}, ${point.y} (${point.space})`}
              </title>
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
        {visualization.actions.map((action) => {
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
      <ol
        className="macro-visualization-list"
        aria-label="Ordered macro actions"
      >
        {visualization.actions.map((action) => (
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
}
