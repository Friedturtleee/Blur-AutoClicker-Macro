export type MacroActionKind = "move" | "click" | "scroll";
export type CoordinateSpace = "screen" | "client";

export interface MacroVisualAction {
  kind: MacroActionKind;
  order: number;
  repetitions: number;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  space: CoordinateSpace;
  button?: string;
  count?: number;
  radius?: number;
  delta?: number;
}

export interface MacroClickPoint {
  x: number;
  y: number;
  space: CoordinateSpace;
  firstOrder: number;
  clicks: number;
  button: string;
  radius: number;
}

export interface MacroVisualization {
  actions: MacroVisualAction[];
  clickPoints: MacroClickPoint[];
}

interface CursorPosition {
  x: number;
  y: number;
  space: CoordinateSpace;
}

const INTEGER_OPTION_PATTERNS: Record<string, RegExp> = {
  x: /(?:^|\s)x=(-?\d+)(?=\s|$)/,
  y: /(?:^|\s)y=(-?\d+)(?=\s|$)/,
  count: /(?:^|\s)count=(-?\d+)(?=\s|$)/,
  radius: /(?:^|\s)radius=(-?\d+)(?=\s|$)/,
  delta: /(?:^|\s)delta=(-?\d+)(?=\s|$)/,
};

const STRING_OPTION_PATTERNS: Record<string, RegExp> = {
  button: /(?:^|\s)button=([\w-]+)(?=\s|$)/,
  space: /(?:^|\s)space=([\w-]+)(?=\s|$)/,
};

function stripComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (char === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}

function braceCounts(line: string) {
  let quoted = false;
  let escaped = false;
  let open = 0;
  let close = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "{") open += 1;
    else if (!quoted && char === "}") close += 1;
  }
  return { open, close };
}

function integerOption(line: string, name: string): number | undefined {
  const pattern = INTEGER_OPTION_PATTERNS[name];
  if (!pattern) return undefined;
  const match = line.match(pattern);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function signed32Option(line: string, name: string): number | undefined {
  const value = integerOption(line, name);
  return value !== undefined &&
    value >= -2_147_483_648 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}

function stringOption(line: string, name: string, fallback: string): string {
  const pattern = STRING_OPTION_PATTERNS[name];
  const match = pattern ? line.match(pattern) : null;
  return match?.[1] ?? fallback;
}

function actionKey(action: MacroVisualAction): string {
  return [
    action.kind,
    action.space,
    action.x ?? "?",
    action.y ?? "?",
    action.fromX ?? "?",
    action.fromY ?? "?",
    action.button ?? "",
    action.radius ?? 0,
    action.kind === "scroll" ? Math.sign(action.delta ?? 0) : "",
  ].join(":");
}

export function buildMacroVisualization(source: string): MacroVisualization {
  const actions: MacroVisualAction[] = [];
  const blockMultipliers: number[] = [1];
  let cursor: CursorPosition | null = null;
  let currentMode = "foreground";
  let actionCount = 0;

  for (const sourceLine of source.split(/\r?\n/)) {
    const line = stripComment(sourceLine).trim();
    if (!line) continue;

    const nextMode = line
      .match(/^mode\s+(foreground|background)\b/i)?.[1]
      ?.toLowerCase();
    if (nextMode && nextMode !== currentMode) {
      cursor = null;
      currentMode = nextMode;
    }

    const repeat = line.match(/^repeat\s+(\d+)\s*\{/i);
    const blockHeader = /^(?:repeat\s+\d+|if\b|while\b).*\{/i.test(line);
    if (repeat) {
      const repetitions = Math.max(0, Math.min(Number(repeat[1]), 1_000_000));
      blockMultipliers.push(
        Math.min(
          1_000_000,
          blockMultipliers[blockMultipliers.length - 1] * repetitions,
        ),
      );
    } else if (blockHeader) {
      blockMultipliers.push(blockMultipliers[blockMultipliers.length - 1]);
    } else {
      const multiplier = blockMultipliers[blockMultipliers.length - 1];
      const command = line.match(/^(move|click|scroll)\b/i)?.[1]?.toLowerCase();
      if (command && multiplier > 0) {
        const explicitX = signed32Option(line, "x");
        const explicitY = signed32Option(line, "y");
        const hasCoordinates =
          explicitX !== undefined && explicitY !== undefined;
        const defaultSpace =
          command === "move" || hasCoordinates
            ? "screen"
            : (cursor?.space ?? "screen");
        const space = stringOption(
          line,
          "space",
          defaultSpace,
        ) as CoordinateSpace;
        const position = hasCoordinates
          ? { x: explicitX, y: explicitY, space }
          : cursor?.space === space
            ? cursor
            : null;
        let action: MacroVisualAction | null = null;

        if (command === "move") {
          if (hasCoordinates) {
            action = {
              kind: "move",
              order: ++actionCount,
              repetitions: multiplier,
              fromX: cursor?.space === space ? cursor.x : undefined,
              fromY: cursor?.space === space ? cursor.y : undefined,
              x: explicitX,
              y: explicitY,
              space,
            };
            cursor = { x: explicitX, y: explicitY, space };
          }
        } else if (command === "click") {
          const button = stringOption(line, "button", "left");
          const count = integerOption(line, "count") ?? 1;
          const radius = integerOption(line, "radius") ?? 0;
          if (
            count >= 1 &&
            count <= 10_000 &&
            radius >= 0 &&
            radius <= 2_147_483_647
          ) {
            action = {
              kind: "click",
              order: ++actionCount,
              repetitions: multiplier,
              ...(position ? { x: position.x, y: position.y } : {}),
              space: position?.space ?? space,
              button,
              count: count * multiplier,
              radius,
            };
          }
          if (hasCoordinates) cursor = { x: explicitX, y: explicitY, space };
        } else {
          const delta = signed32Option(line, "delta") ?? 0;
          action = {
            kind: "scroll",
            order: ++actionCount,
            repetitions: multiplier,
            ...(position ? { x: position.x, y: position.y } : {}),
            space: position?.space ?? space,
            delta: delta * multiplier,
          };
          if (hasCoordinates) cursor = { x: explicitX, y: explicitY, space };
        }

        if (action) {
          const previous = actions[actions.length - 1];
          if (previous && actionKey(previous) === actionKey(action)) {
            previous.repetitions += action.repetitions;
            if (action.kind === "click")
              previous.count = (previous.count ?? 0) + (action.count ?? 0);
            if (action.kind === "scroll")
              previous.delta = (previous.delta ?? 0) + (action.delta ?? 0);
          } else {
            actions.push(action);
          }
        }
      }
    }

    const { open, close } = braceCounts(line);
    if (blockHeader) {
      // Headers can contain empty inline blocks such as `repeat 3 {}` or
      // `if ready {} else {}`. Account for each brace so their frame does not
      // leak a loop multiplier into actions that follow the block.
      for (let index = 1; index < open; index += 1) {
        blockMultipliers.push(blockMultipliers[blockMultipliers.length - 1]);
      }
      for (let index = 0; index < close; index += 1) {
        if (blockMultipliers.length > 1) blockMultipliers.pop();
      }
    } else {
      for (let index = 0; index < close; index += 1) {
        if (blockMultipliers.length > 1) blockMultipliers.pop();
      }
      for (let index = 0; index < open; index += 1) {
        blockMultipliers.push(blockMultipliers[blockMultipliers.length - 1]);
      }
    }
  }

  actions.forEach((action, index) => {
    action.order = index + 1;
  });

  const pointsByKey = new Map<string, MacroClickPoint>();
  actions.forEach((action) => {
    if (
      action.kind !== "click" ||
      action.x === undefined ||
      action.y === undefined
    )
      return;
    const radius = action.radius ?? 0;
    const key = `${action.space}:${action.x}:${action.y}:${action.button}:${radius}`;
    const point = pointsByKey.get(key);
    if (point) point.clicks += action.count ?? 1;
    else {
      pointsByKey.set(key, {
        x: action.x,
        y: action.y,
        space: action.space,
        firstOrder: action.order,
        clicks: action.count ?? 1,
        button: action.button ?? "left",
        radius,
      });
    }
  });

  return { actions, clickPoints: [...pointsByKey.values()] };
}
