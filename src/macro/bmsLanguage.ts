import { HighlightStyle, StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const commands = new Set([
  "target",
  "mode",
  "move",
  "click",
  "mouse_down",
  "mouse_up",
  "key_down",
  "key_up",
  "press",
  "type",
  "scroll",
  "wait",
  "let",
  "set",
  "repeat",
  "while",
  "if",
  "else",
  "window_exists",
  "log",
]);

const options = new Set([
  "process",
  "title_contains",
  "class",
  "strict",
  "x",
  "y",
  "space",
  "duration",
  "button",
  "count",
  "radius",
  "delta",
]);

interface BmStreamState {
  atStatementStart: boolean;
}

export const bmsLanguage = StreamLanguage.define<BmStreamState>({
  startState: () => ({ atStatementStart: true }),
  blankLine: (state) => {
    state.atStatementStart = true;
  },
  token(stream, state) {
    if (stream.sol()) state.atStatementStart = true;
    if (stream.eatSpace()) return null;

    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      while (!stream.eol()) {
        const char = stream.next();
        if (char === '"' && !escaped) break;
        if (char === "\\" && !escaped) escaped = true;
        else escaped = false;
      }
      state.atStatementStart = false;
      return "string";
    }

    if (stream.match(/^-?\d+(?:ms|s|m|h)?\b/i)) return "number";
    if (stream.match(/^(?:==|!=|<=|>=|[=<>+!-])/)) return "operator";
    if (stream.match(/^[{}(),]/)) return "punctuation";

    const matchedWord = stream.match(/^[A-Za-z_][\w-]*/);
    if (matchedWord) {
      const word = String(matchedWord);
      if (state.atStatementStart) {
        state.atStatementStart = false;
        if (commands.has(word)) return "keyword";
        return "invalid";
      }
      if (options.has(word)) return "propertyName";
      if (
        word === "true" ||
        word === "false" ||
        word === "foreground" ||
        word === "background"
      ) {
        return "atom";
      }
      if (
        word === "left" ||
        word === "right" ||
        word === "middle" ||
        word === "screen" ||
        word === "client"
      ) {
        return "atom";
      }
      return "variableName";
    }

    stream.next();
    return "content";
  },
});

export const bmsHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent-strong)", fontWeight: "700" },
  { tag: tags.comment, color: "var(--text-dim)", fontStyle: "italic" },
  { tag: tags.string, color: "#e6b87a" },
  { tag: tags.number, color: "#83c5e8" },
  { tag: tags.propertyName, color: "#a8c7fa" },
  { tag: tags.variableName, color: "var(--text-primary)" },
  { tag: tags.atom, color: "#c5a3e8" },
  { tag: tags.operator, color: "var(--text-muted)" },
  { tag: tags.punctuation, color: "var(--text-muted)" },
  {
    tag: tags.invalid,
    color: "var(--danger)",
    textDecoration: "underline wavy",
  },
]);
