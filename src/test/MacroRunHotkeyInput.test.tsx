import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MacroRunHotkeyInput from "../components/panels/macro/MacroRunHotkeyInput";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("MacroRunHotkeyInput", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      (command: string, args?: { hotkey: string }) =>
        Promise.resolve(
          command === "normalize_hotkey_input"
            ? (args?.hotkey ?? "")
            : undefined,
        ),
    );
  });

  it("discards uncommitted text when Escape cancels editing", async () => {
    const onChange = vi.fn();
    render(
      <MacroRunHotkeyInput
        value="ctrl+shift+m"
        conflicts={[]}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Macro run hotkey text",
    });
    input.focus();
    fireEvent.change(input, { target: { value: "alt+k" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(input).toHaveValue("ctrl+shift+m"));
    expect(onChange).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("normalize_hotkey_input", {
      hotkey: "alt+k",
    });
  });

  it("normalizes and commits text when Enter confirms it", async () => {
    const onChange = vi.fn();
    render(
      <MacroRunHotkeyInput
        value="ctrl+shift+m"
        conflicts={[]}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Macro run hotkey text",
    });
    input.focus();
    fireEvent.change(input, { target: { value: "alt+k" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("alt+k"));
    expect(invokeMock).toHaveBeenCalledWith("normalize_hotkey_input", {
      hotkey: "alt+k",
    });
  });
});
