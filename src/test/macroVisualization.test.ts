import { describe, expect, it } from "vitest";
import { buildMacroVisualization } from "../macro/visualization";

describe("macro action visualization", () => {
  it("does not leak the enclosing repeat count past an empty inline block", () => {
    const visualization = buildMacroVisualization(
      [
        "repeat 3 {",
        "  if true {}",
        "  click x=10 y=20",
        "}",
        "click x=30 y=40",
      ].join("\n"),
    );

    expect(visualization.actions).toHaveLength(2);
    expect(visualization.actions[0].count).toBe(3);
    expect(visualization.actions[1].count).toBe(1);
  });

  it("does not leak an empty repeat block's count to following actions", () => {
    const visualization = buildMacroVisualization(
      ["repeat 5 {}", "click x=30 y=40"].join("\n"),
    );

    expect(visualization.actions).toHaveLength(1);
    expect(visualization.actions[0].count).toBe(1);
  });
});
