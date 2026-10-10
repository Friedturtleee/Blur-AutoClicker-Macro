use serde::Serialize;
use tauri::Manager;

const MAX_SOURCE_BYTES: usize = 1_000_000;
const MAX_STATEMENTS: usize = 50_000;
const MAX_BLOCK_DEPTH: usize = 32;
const MAX_EXPRESSION_NESTING: usize = 32;
const MAX_EXPRESSION_NODES: usize = 256;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroDiagnostic {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroValidation {
    pub ok: bool,
    pub errors: Vec<MacroDiagnostic>,
    pub statement_count: usize,
}

#[derive(Clone, Debug, PartialEq)]
enum TokenKind {
    Ident(String),
    String(String),
    Number(i64),
    Duration(u64),
    LBrace,
    RBrace,
    LParen,
    RParen,
    Equal,
    EqualEqual,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    Plus,
    Minus,
    Newline,
    Eof,
}

#[derive(Clone, Debug)]
struct Token {
    kind: TokenKind,
    line: usize,
    column: usize,
}

fn diagnostic(token: &Token, message: impl Into<String>) -> MacroDiagnostic {
    MacroDiagnostic {
        line: token.line,
        column: token.column,
        message: message.into(),
    }
}

fn lex(source: &str) -> Result<Vec<Token>, MacroDiagnostic> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("Source exceeds the {MAX_SOURCE_BYTES}-byte limit"),
        });
    }

    let chars: Vec<char> = source.chars().collect();
    let (mut i, mut line, mut column) = (0, 1, 1);
    let mut tokens = Vec::new();
    while i < chars.len() {
        let ch = chars[i];
        if ch == ' ' || ch == '\t' || ch == '\r' {
            i += 1;
            column += 1;
            continue;
        }
        if ch == '\n' {
            tokens.push(Token {
                kind: TokenKind::Newline,
                line,
                column,
            });
            i += 1;
            line += 1;
            column = 1;
            continue;
        }
        if ch == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
                column += 1;
            }
            continue;
        }

        let token_line = line;
        let token_column = column;
        let simple = match ch {
            '{' => Some(TokenKind::LBrace),
            '}' => Some(TokenKind::RBrace),
            '(' => Some(TokenKind::LParen),
            ')' => Some(TokenKind::RParen),
            '+' => Some(TokenKind::Plus),
            '-' if chars.get(i + 1).is_some_and(|c| c.is_ascii_digit()) => None,
            '-' => Some(TokenKind::Minus),
            '=' if chars.get(i + 1) == Some(&'=') => {
                i += 1;
                column += 1;
                Some(TokenKind::EqualEqual)
            }
            '=' => Some(TokenKind::Equal),
            '!' if chars.get(i + 1) == Some(&'=') => {
                i += 1;
                column += 1;
                Some(TokenKind::NotEqual)
            }
            '<' if chars.get(i + 1) == Some(&'=') => {
                i += 1;
                column += 1;
                Some(TokenKind::LessEqual)
            }
            '<' => Some(TokenKind::Less),
            '>' if chars.get(i + 1) == Some(&'=') => {
                i += 1;
                column += 1;
                Some(TokenKind::GreaterEqual)
            }
            '>' => Some(TokenKind::Greater),
            _ => None,
        };
        if let Some(kind) = simple {
            tokens.push(Token {
                kind,
                line: token_line,
                column: token_column,
            });
            i += 1;
            column += 1;
            continue;
        }

        if ch == '"' {
            i += 1;
            column += 1;
            let mut value = String::new();
            let mut closed = false;
            while i < chars.len() {
                match chars[i] {
                    '"' => {
                        i += 1;
                        column += 1;
                        closed = true;
                        break;
                    }
                    '\\' => {
                        i += 1;
                        column += 1;
                        let Some(escaped) = chars.get(i).copied() else {
                            break;
                        };
                        match escaped {
                            '"' => value.push('"'),
                            '\\' => value.push('\\'),
                            'n' => value.push('\n'),
                            'r' => value.push('\r'),
                            't' => value.push('\t'),
                            other => {
                                return Err(MacroDiagnostic {
                                    line,
                                    column,
                                    message: format!("Unsupported string escape \\{other}"),
                                });
                            }
                        }
                        i += 1;
                        column += 1;
                    }
                    '\n' => {
                        return Err(MacroDiagnostic {
                            line: token_line,
                            column: token_column,
                            message: "Strings cannot contain a literal newline".into(),
                        });
                    }
                    c => {
                        value.push(c);
                        i += 1;
                        column += 1;
                    }
                }
            }
            if !closed {
                return Err(MacroDiagnostic {
                    line: token_line,
                    column: token_column,
                    message: "Unterminated string".into(),
                });
            }
            tokens.push(Token {
                kind: TokenKind::String(value),
                line: token_line,
                column: token_column,
            });
            continue;
        }

        if ch == '-' || ch.is_ascii_digit() {
            let negative = ch == '-';
            if negative {
                i += 1;
                column += 1;
            }
            let number_start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
                column += 1;
            }
            let digits: String = chars[number_start..i].iter().collect();
            let value = digits.parse::<i64>().map_err(|_| MacroDiagnostic {
                line: token_line,
                column: token_column,
                message: "Integer is outside the supported range".into(),
            })?;
            let value = if negative { -value } else { value };
            let suffix_start = i;
            while i < chars.len() && chars[i].is_ascii_alphabetic() {
                i += 1;
                column += 1;
            }
            let suffix: String = chars[suffix_start..i].iter().collect();
            if suffix.is_empty() {
                tokens.push(Token {
                    kind: TokenKind::Number(value),
                    line: token_line,
                    column: token_column,
                });
            } else {
                let multiplier: u64 = match suffix.as_str() {
                    "ms" => 1,
                    "s" => 1_000,
                    _ => {
                        return Err(MacroDiagnostic {
                            line: token_line,
                            column: token_column,
                            message: "Duration must use ms or s".into(),
                        });
                    }
                };
                if value < 0 {
                    return Err(MacroDiagnostic {
                        line: token_line,
                        column: token_column,
                        message: "Duration cannot be negative".into(),
                    });
                }
                let millis = (value as u64).saturating_mul(multiplier);
                tokens.push(Token {
                    kind: TokenKind::Duration(millis),
                    line: token_line,
                    column: token_column,
                });
            }
            continue;
        }

        if ch.is_ascii_alphabetic() || ch == '_' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '-')
            {
                i += 1;
                column += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Ident(chars[start..i].iter().collect()),
                line: token_line,
                column: token_column,
            });
            continue;
        }

        return Err(MacroDiagnostic {
            line,
            column,
            message: format!("Unexpected character {ch:?}"),
        });
    }
    tokens.push(Token {
        kind: TokenKind::Eof,
        line,
        column,
    });
    Ok(tokens)
}

#[derive(Clone, Debug, PartialEq)]
enum Expr {
    Integer(i64),
    Boolean(bool),
    Variable(String),
    Add(Box<Expr>, Box<Expr>),
    Subtract(Box<Expr>, Box<Expr>),
    Compare(CompareOp, Box<Expr>, Box<Expr>),
    WindowExists { process: String },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum CompareOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum CoordinateSpace {
    Screen,
    Client,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TargetSelector {
    pub process: Option<String>,
    pub title_contains: Option<String>,
    pub class_name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExecutionMode {
    Foreground,
    Background,
}

#[derive(Clone, Debug, PartialEq)]
enum Statement {
    Target(TargetSelector),
    Mode {
        mode: ExecutionMode,
        strict: bool,
    },
    Move {
        x: i32,
        y: i32,
        space: CoordinateSpace,
        duration_ms: u64,
    },
    Click {
        button: MouseButton,
        x: Option<i32>,
        y: Option<i32>,
        space: CoordinateSpace,
        count: u32,
        radius: u32,
    },
    MouseDown(MouseButton),
    MouseUp(MouseButton),
    KeyDown(String),
    KeyUp(String),
    Press(String),
    Type(String),
    Scroll {
        delta: i32,
        x: Option<i32>,
        y: Option<i32>,
        space: CoordinateSpace,
    },
    Wait(u64),
    Let {
        name: String,
        value: Expr,
    },
    Set {
        name: String,
        value: Expr,
    },
    Repeat {
        count: u32,
        body: Vec<Statement>,
    },
    While {
        condition: Expr,
        body: Vec<Statement>,
    },
    If {
        condition: Expr,
        body: Vec<Statement>,
        otherwise: Vec<Statement>,
    },
    Log(String),
}

#[derive(Clone, Debug)]
struct Program {
    statements: Vec<Statement>,
}

struct Parser {
    tokens: Vec<Token>,
    cursor: usize,
    statement_count: usize,
    expression_nesting: usize,
    expression_nodes: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            cursor: 0,
            statement_count: 0,
            expression_nesting: 0,
            expression_nodes: 0,
        }
    }

    fn current(&self) -> &Token {
        &self.tokens[self.cursor.min(self.tokens.len() - 1)]
    }

    fn advance(&mut self) -> Token {
        let token = self.current().clone();
        if !matches!(token.kind, TokenKind::Eof) {
            self.cursor += 1;
        }
        token
    }

    fn at(&self, expected: &TokenKind) -> bool {
        std::mem::discriminant(&self.current().kind) == std::mem::discriminant(expected)
    }

    fn skip_newlines(&mut self) {
        while self.at(&TokenKind::Newline) {
            self.advance();
        }
    }

    fn expect(&mut self, expected: TokenKind, message: &str) -> Result<Token, MacroDiagnostic> {
        if self.at(&expected) {
            Ok(self.advance())
        } else {
            Err(diagnostic(self.current(), message))
        }
    }

    fn expect_ident(&mut self, message: &str) -> Result<String, MacroDiagnostic> {
        match self.advance() {
            Token {
                kind: TokenKind::Ident(value),
                ..
            } => Ok(value),
            token => Err(diagnostic(&token, message)),
        }
    }

    fn expect_string(&mut self, message: &str) -> Result<String, MacroDiagnostic> {
        match self.advance() {
            Token {
                kind: TokenKind::String(value),
                ..
            } => Ok(value),
            token => Err(diagnostic(&token, message)),
        }
    }

    fn expect_number(&mut self, message: &str) -> Result<i64, MacroDiagnostic> {
        match self.advance() {
            Token {
                kind: TokenKind::Number(value),
                ..
            } => Ok(value),
            token => Err(diagnostic(&token, message)),
        }
    }

    fn parse(mut self) -> Result<(Program, usize), MacroDiagnostic> {
        let statements = self.parse_statements(false, 0)?;
        Ok((Program { statements }, self.statement_count))
    }

    fn parse_statements(
        &mut self,
        in_block: bool,
        depth: usize,
    ) -> Result<Vec<Statement>, MacroDiagnostic> {
        if depth > MAX_BLOCK_DEPTH {
            return Err(diagnostic(
                self.current(),
                format!("Block nesting exceeds the {MAX_BLOCK_DEPTH}-level limit"),
            ));
        }
        let mut statements = Vec::new();
        self.skip_newlines();
        loop {
            if self.at(&TokenKind::Eof) {
                if in_block {
                    return Err(diagnostic(self.current(), "Expected } before end of file"));
                }
                break;
            }
            if self.at(&TokenKind::RBrace) {
                if !in_block {
                    return Err(diagnostic(self.current(), "Unexpected }"));
                }
                self.advance();
                break;
            }
            statements.push(self.parse_statement(depth)?);
            self.statement_count += 1;
            if self.statement_count > MAX_STATEMENTS {
                return Err(diagnostic(
                    self.current(),
                    format!("Program exceeds the {MAX_STATEMENTS}-statement limit"),
                ));
            }
            if self.at(&TokenKind::Newline) {
                self.skip_newlines();
            } else if !self.at(&TokenKind::RBrace) && !self.at(&TokenKind::Eof) {
                return Err(diagnostic(
                    self.current(),
                    "Expected a newline or block end after the statement",
                ));
            }
        }
        Ok(statements)
    }

    fn parse_block(&mut self, depth: usize) -> Result<Vec<Statement>, MacroDiagnostic> {
        self.expect(TokenKind::LBrace, "Expected { to start block")?;
        if !self.at(&TokenKind::Newline) && !self.at(&TokenKind::RBrace) {
            return Err(diagnostic(
                self.current(),
                "Expected a newline or empty block after {",
            ));
        }
        self.skip_newlines();
        self.parse_statements(true, depth + 1)
    }

    fn parse_statement(&mut self, depth: usize) -> Result<Statement, MacroDiagnostic> {
        let command_token = self.current().clone();
        let command = self.expect_ident("Expected a command")?;
        let parsed = match command.as_str() {
            "target" => {
                let values = self.parse_options()?;
                ensure_known_options(
                    &values,
                    &["process", "title_contains", "class"],
                    self.current(),
                )?;
                let selector = TargetSelector {
                    process: option_string(&values, "process", false)?,
                    title_contains: option_string(&values, "title_contains", false)?,
                    class_name: option_string(&values, "class", false)?,
                };
                if selector.process.is_none()
                    && selector.title_contains.is_none()
                    && selector.class_name.is_none()
                {
                    return Err(diagnostic(
                        self.current(),
                        "target needs at least one selector",
                    ));
                }
                Ok(Statement::Target(selector))
            }
            "mode" => {
                let mode = self.expect_ident("Expected foreground or background")?;
                let values = self.parse_options()?;
                ensure_known_options(&values, &["strict"], self.current())?;
                let strict = option_bool(&values, "strict", false)?;
                match mode.as_str() {
                    "foreground" => Ok(Statement::Mode {
                        mode: ExecutionMode::Foreground,
                        strict: true,
                    }),
                    "background" => Ok(Statement::Mode {
                        mode: ExecutionMode::Background,
                        strict,
                    }),
                    _ => Err(diagnostic(
                        self.current(),
                        "Expected foreground or background",
                    )),
                }
            }
            "move" => {
                let values = self.parse_options()?;
                ensure_known_options(&values, &["x", "y", "space", "duration"], self.current())?;
                Ok(Statement::Move {
                    x: option_i32(&values, "x", true, 0)?.unwrap_or(0),
                    y: option_i32(&values, "y", true, 0)?.unwrap_or(0),
                    space: option_space(&values, CoordinateSpace::Screen)?,
                    duration_ms: option_duration(&values, "duration", 0)?,
                })
            }
            "click" => {
                let values = self.parse_options()?;
                ensure_known_options(
                    &values,
                    &["button", "x", "y", "space", "count", "radius"],
                    self.current(),
                )?;
                let x = option_i32(&values, "x", false, 0)?;
                let y = option_i32(&values, "y", false, 0)?;
                if x.is_some() != y.is_some() {
                    return Err(diagnostic(
                        self.current(),
                        "click x and y must be provided together",
                    ));
                }
                let count = option_u32(&values, "count", 1)?;
                if count == 0 || count > 10_000 {
                    return Err(diagnostic(
                        self.current(),
                        "click count must be from 1 to 10000",
                    ));
                }
                let radius = option_u32(&values, "radius", 0)?;
                if radius > i32::MAX as u32 {
                    return Err(diagnostic(
                        self.current(),
                        "click radius must fit a signed 32-bit coordinate range",
                    ));
                }
                Ok(Statement::Click {
                    button: option_button(&values)?,
                    x,
                    y,
                    space: option_space(&values, CoordinateSpace::Screen)?,
                    count,
                    radius,
                })
            }
            "mouse_down" | "mouse_up" => {
                let values = self.parse_options()?;
                ensure_known_options(&values, &["button"], self.current())?;
                let button = option_button(&values)?;
                if command == "mouse_down" {
                    Ok(Statement::MouseDown(button))
                } else {
                    Ok(Statement::MouseUp(button))
                }
            }
            "key_down" | "key_up" | "press" | "type" | "log" => {
                let value = self.expect_string("Expected a quoted string argument")?;
                if !self.at(&TokenKind::Newline)
                    && !self.at(&TokenKind::RBrace)
                    && !self.at(&TokenKind::Eof)
                {
                    return Err(diagnostic(
                        self.current(),
                        "Unexpected extra command argument",
                    ));
                }
                match command.as_str() {
                    "key_down" | "key_up" => {
                        key_code(&value).map_err(|error| diagnostic(self.current(), error))?;
                    }
                    "press" => {
                        let keys = value
                            .split('+')
                            .map(str::trim)
                            .filter(|key| !key.is_empty())
                            .collect::<Vec<_>>();
                        if keys.is_empty() {
                            return Err(diagnostic(
                                self.current(),
                                "press requires at least one key",
                            ));
                        }
                        for key in keys {
                            key_code(key).map_err(|error| diagnostic(self.current(), error))?;
                        }
                    }
                    "type" if value.encode_utf16().count() > 10_000 => {
                        return Err(diagnostic(
                            self.current(),
                            "type text is limited to 10000 UTF-16 code units per statement",
                        ));
                    }
                    _ => {}
                }
                match command.as_str() {
                    "key_down" => Ok(Statement::KeyDown(value)),
                    "key_up" => Ok(Statement::KeyUp(value)),
                    "press" => Ok(Statement::Press(value)),
                    "type" => Ok(Statement::Type(value)),
                    _ => Ok(Statement::Log(value)),
                }
            }
            "scroll" => {
                let values = self.parse_options()?;
                ensure_known_options(&values, &["delta", "x", "y", "space"], self.current())?;
                let x = option_i32(&values, "x", false, 0)?;
                let y = option_i32(&values, "y", false, 0)?;
                if x.is_some() != y.is_some() {
                    return Err(diagnostic(
                        self.current(),
                        "scroll x and y must be provided together",
                    ));
                }
                Ok(Statement::Scroll {
                    delta: option_i32(&values, "delta", true, 0)?.unwrap_or(0),
                    x,
                    y,
                    space: option_space(&values, CoordinateSpace::Screen)?,
                })
            }
            "wait" => {
                let token = self.advance();
                match token.kind {
                    TokenKind::Duration(ms) => Ok(Statement::Wait(ms)),
                    TokenKind::Number(ms) if ms >= 0 => Ok(Statement::Wait(ms as u64)),
                    _ => Err(diagnostic(
                        &token,
                        "Expected a duration such as 250ms or 2s",
                    )),
                }
            }
            "let" | "set" => {
                let name = self.expect_ident("Expected a variable name")?;
                self.expect(TokenKind::Equal, "Expected = after variable name")?;
                let value = self.parse_expression()?;
                if command == "let" {
                    Ok(Statement::Let { name, value })
                } else {
                    Ok(Statement::Set { name, value })
                }
            }
            "repeat" => {
                let count = self.expect_number("repeat requires an integer count")?;
                if !(0..=1_000_000).contains(&count) {
                    return Err(diagnostic(
                        self.current(),
                        "repeat count must be from 0 to 1000000",
                    ));
                }
                self.skip_newlines();
                Ok(Statement::Repeat {
                    count: count as u32,
                    body: self.parse_block(depth)?,
                })
            }
            "while" => {
                let condition = self.parse_expression()?;
                self.skip_newlines();
                Ok(Statement::While {
                    condition,
                    body: self.parse_block(depth)?,
                })
            }
            "if" => {
                let condition = self.parse_expression()?;
                self.skip_newlines();
                let body = self.parse_block(depth)?;
                self.skip_newlines();
                let otherwise = if matches!(&self.current().kind, TokenKind::Ident(word) if word == "else")
                {
                    self.advance();
                    self.skip_newlines();
                    self.parse_block(depth)?
                } else {
                    Vec::new()
                };
                Ok(Statement::If {
                    condition,
                    body,
                    otherwise,
                })
            }
            other => Err(diagnostic(
                self.current(),
                format!("Unknown command {other:?}"),
            )),
        };
        parsed.map_err(|mut error| {
            if error.line == 1 && error.column == 1 {
                error.line = command_token.line;
                error.column = command_token.column;
            }
            error
        })
    }

    fn parse_options(
        &mut self,
    ) -> Result<std::collections::HashMap<String, OptionValue>, MacroDiagnostic> {
        let mut values = std::collections::HashMap::new();
        while !self.at(&TokenKind::Newline)
            && !self.at(&TokenKind::RBrace)
            && !self.at(&TokenKind::Eof)
        {
            let key = self.expect_ident("Expected option name")?;
            self.expect(TokenKind::Equal, "Expected = after option name")?;
            let token = self.advance();
            let value = match &token.kind {
                TokenKind::String(value) => OptionValue::String(value.clone()),
                TokenKind::Ident(value) if value == "true" => OptionValue::Boolean(true),
                TokenKind::Ident(value) if value == "false" => OptionValue::Boolean(false),
                TokenKind::Ident(value) => OptionValue::Ident(value.clone()),
                TokenKind::Number(value) => OptionValue::Number(*value),
                TokenKind::Duration(value) => OptionValue::Duration(*value),
                _ => {
                    return Err(diagnostic(
                        &token,
                        "Expected string, number, boolean, or duration",
                    ))
                }
            };
            if values.insert(key.clone(), value).is_some() {
                return Err(diagnostic(
                    &token,
                    format!("Option {key:?} appears more than once"),
                ));
            }
        }
        Ok(values)
    }

    fn parse_expression(&mut self) -> Result<Expr, MacroDiagnostic> {
        // One parser frame belongs to the top-level expression. The remaining
        // allowed frames represent actual parenthesized nesting.
        if self.expression_nesting > MAX_EXPRESSION_NESTING {
            return Err(diagnostic(
                self.current(),
                format!("Expression nesting exceeds the {MAX_EXPRESSION_NESTING}-level limit"),
            ));
        }
        if self.expression_nesting == 0 {
            self.expression_nodes = 0;
        }
        self.expression_nesting += 1;
        let result = self.parse_comparison();
        self.expression_nesting -= 1;
        result
    }

    fn count_expression_node(&mut self, token: &Token) -> Result<(), MacroDiagnostic> {
        self.expression_nodes += 1;
        if self.expression_nodes > MAX_EXPRESSION_NODES {
            return Err(diagnostic(
                token,
                format!("Expression exceeds the {MAX_EXPRESSION_NODES}-node limit"),
            ));
        }
        Ok(())
    }

    fn parse_comparison(&mut self) -> Result<Expr, MacroDiagnostic> {
        let left = self.parse_additive()?;
        let op = match self.current().kind {
            TokenKind::EqualEqual => Some(CompareOp::Eq),
            TokenKind::NotEqual => Some(CompareOp::Ne),
            TokenKind::Less => Some(CompareOp::Lt),
            TokenKind::LessEqual => Some(CompareOp::Le),
            TokenKind::Greater => Some(CompareOp::Gt),
            TokenKind::GreaterEqual => Some(CompareOp::Ge),
            _ => None,
        };
        if let Some(op) = op {
            let operator = self.current().clone();
            self.advance();
            self.count_expression_node(&operator)?;
            let right = self.parse_additive()?;
            Ok(Expr::Compare(op, Box::new(left), Box::new(right)))
        } else {
            Ok(left)
        }
    }

    fn parse_additive(&mut self) -> Result<Expr, MacroDiagnostic> {
        let mut expr = self.parse_primary()?;
        loop {
            let add = self.at(&TokenKind::Plus);
            if !add && !self.at(&TokenKind::Minus) {
                break;
            }
            let operator = self.current().clone();
            self.advance();
            self.count_expression_node(&operator)?;
            let right = self.parse_primary()?;
            expr = if add {
                Expr::Add(Box::new(expr), Box::new(right))
            } else {
                Expr::Subtract(Box::new(expr), Box::new(right))
            };
        }
        Ok(expr)
    }

    fn parse_primary(&mut self) -> Result<Expr, MacroDiagnostic> {
        let token = self.advance();
        match token.kind {
            TokenKind::Number(value) => Ok(Expr::Integer(value)),
            TokenKind::Minus => match self.advance() {
                Token {
                    kind: TokenKind::Number(value),
                    ..
                } => Ok(Expr::Integer(-value)),
                token => Err(diagnostic(&token, "Unary minus requires an integer")),
            },
            TokenKind::Ident(value) if value == "true" => Ok(Expr::Boolean(true)),
            TokenKind::Ident(value) if value == "false" => Ok(Expr::Boolean(false)),
            TokenKind::Ident(value) if value == "window_exists" => {
                self.expect(TokenKind::LParen, "Expected ( after window_exists")?;
                let key = self.expect_ident("Expected process= in window_exists")?;
                if key != "process" {
                    return Err(diagnostic(
                        self.current(),
                        "window_exists only accepts process",
                    ));
                }
                self.expect(TokenKind::Equal, "Expected = after process")?;
                let process = self.expect_string("Expected a quoted executable name")?;
                self.expect(TokenKind::RParen, "Expected ) after window_exists selector")?;
                Ok(Expr::WindowExists { process })
            }
            TokenKind::Ident(value) => Ok(Expr::Variable(value)),
            TokenKind::LParen => {
                let expr = self.parse_expression()?;
                self.expect(TokenKind::RParen, "Expected ) after expression")?;
                Ok(expr)
            }
            _ => Err(diagnostic(
                &token,
                "Expected an integer, boolean, variable, or condition",
            )),
        }
    }
}

#[derive(Clone, Debug)]
enum OptionValue {
    String(String),
    Ident(String),
    Boolean(bool),
    Number(i64),
    Duration(u64),
}

fn ensure_known_options(
    values: &std::collections::HashMap<String, OptionValue>,
    known: &[&str],
    token: &Token,
) -> Result<(), MacroDiagnostic> {
    for key in values.keys() {
        if !known.contains(&key.as_str()) {
            return Err(diagnostic(token, format!("Unknown option {key:?}")));
        }
    }
    Ok(())
}

fn option_string(
    values: &std::collections::HashMap<String, OptionValue>,
    key: &str,
    required: bool,
) -> Result<Option<String>, MacroDiagnostic> {
    match values.get(key) {
        Some(OptionValue::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("{key} must be a non-empty quoted string"),
        }),
        None if required => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("Missing required option {key}"),
        }),
        None => Ok(None),
    }
}

fn option_bool(
    values: &std::collections::HashMap<String, OptionValue>,
    key: &str,
    fallback: bool,
) -> Result<bool, MacroDiagnostic> {
    match values.get(key) {
        Some(OptionValue::Boolean(value)) => Ok(*value),
        Some(_) => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("{key} must be true or false"),
        }),
        None => Ok(fallback),
    }
}

fn option_i32(
    values: &std::collections::HashMap<String, OptionValue>,
    key: &str,
    required: bool,
    fallback: i32,
) -> Result<Option<i32>, MacroDiagnostic> {
    match values.get(key) {
        Some(OptionValue::Number(value)) => {
            i32::try_from(*value)
                .map(Some)
                .map_err(|_| MacroDiagnostic {
                    line: 1,
                    column: 1,
                    message: format!("{key} must fit in a signed 32-bit integer"),
                })
        }
        Some(_) => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("{key} must be an integer"),
        }),
        None if required => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("Missing required option {key}"),
        }),
        None if fallback != 0 => Ok(Some(fallback)),
        None => Ok(None),
    }
}

fn option_u32(
    values: &std::collections::HashMap<String, OptionValue>,
    key: &str,
    fallback: u32,
) -> Result<u32, MacroDiagnostic> {
    match values.get(key) {
        Some(OptionValue::Number(value)) => u32::try_from(*value).map_err(|_| MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("{key} must be a non-negative 32-bit integer"),
        }),
        Some(_) => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("{key} must be an integer"),
        }),
        None => Ok(fallback),
    }
}

fn option_duration(
    values: &std::collections::HashMap<String, OptionValue>,
    key: &str,
    fallback: u64,
) -> Result<u64, MacroDiagnostic> {
    match values.get(key) {
        Some(OptionValue::Duration(value)) => Ok(*value),
        Some(OptionValue::Number(value)) if *value >= 0 => Ok(*value as u64),
        Some(_) => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: format!("{key} must be a duration such as 100ms or 2s"),
        }),
        None => Ok(fallback),
    }
}

fn option_space(
    values: &std::collections::HashMap<String, OptionValue>,
    fallback: CoordinateSpace,
) -> Result<CoordinateSpace, MacroDiagnostic> {
    match values.get("space") {
        Some(OptionValue::Ident(value)) if value == "screen" => Ok(CoordinateSpace::Screen),
        Some(OptionValue::Ident(value)) if value == "client" => Ok(CoordinateSpace::Client),
        Some(_) => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: "space must be screen or client".into(),
        }),
        None => Ok(fallback),
    }
}

fn option_button(
    values: &std::collections::HashMap<String, OptionValue>,
) -> Result<MouseButton, MacroDiagnostic> {
    match values.get("button") {
        Some(OptionValue::Ident(value)) if value == "left" => Ok(MouseButton::Left),
        Some(OptionValue::Ident(value)) if value == "right" => Ok(MouseButton::Right),
        Some(OptionValue::Ident(value)) if value == "middle" => Ok(MouseButton::Middle),
        Some(_) => Err(MacroDiagnostic {
            line: 1,
            column: 1,
            message: "button must be left, right, or middle".into(),
        }),
        None => Ok(MouseButton::Left),
    }
}

fn parse_program(source: &str) -> Result<(Program, usize), MacroDiagnostic> {
    Parser::new(lex(source)?).parse()
}

pub fn validate_source(source: &str) -> MacroValidation {
    match parse_program(source) {
        Ok((program, statement_count)) => validate_program(&program, statement_count),
        Err(error) => MacroValidation {
            ok: false,
            errors: vec![error],
            statement_count: 0,
        },
    }
}

fn validate_program(program: &Program, statement_count: usize) -> MacroValidation {
    let mut errors = Vec::new();
    validate_mode(
        &program.statements,
        ExecutionMode::Foreground,
        false,
        &mut errors,
    );
    MacroValidation {
        ok: errors.is_empty(),
        errors,
        statement_count,
    }
}

fn validate_mode(
    statements: &[Statement],
    mode: ExecutionMode,
    has_target: bool,
    errors: &mut Vec<MacroDiagnostic>,
) {
    let initial = ValidationState { mode, has_target };
    let _ = validate_statements(statements, vec![initial], errors);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ValidationState {
    mode: ExecutionMode,
    has_target: bool,
}

fn add_validation_error(errors: &mut Vec<MacroDiagnostic>, message: &str) {
    if errors.iter().any(|error| error.message == message) {
        return;
    }
    errors.push(MacroDiagnostic {
        line: 1,
        column: 1,
        message: message.into(),
    });
}

fn merge_validation_states(
    mut states: Vec<ValidationState>,
    additions: Vec<ValidationState>,
) -> Vec<ValidationState> {
    for state in additions {
        if !states.contains(&state) {
            states.push(state);
        }
    }
    states
}

fn validate_statements(
    statements: &[Statement],
    mut states: Vec<ValidationState>,
    errors: &mut Vec<MacroDiagnostic>,
) -> Vec<ValidationState> {
    for statement in statements {
        match statement {
            Statement::Target(_) => {
                for state in &mut states {
                    state.has_target = true;
                }
            }
            Statement::Mode { mode: next, strict } => {
                if *next == ExecutionMode::Background && !strict {
                    add_validation_error(errors, "Background mode requires strict=true");
                }
                for state in &mut states {
                    state.mode = *next;
                }
            }
            Statement::Click { .. } | Statement::Move { .. } | Statement::Scroll { .. } => {
                if states
                    .iter()
                    .any(|state| state.mode == ExecutionMode::Background && !state.has_target)
                {
                    add_validation_error(
                        errors,
                        "Background input requires a target selector before the action",
                    );
                }
                if states.iter().any(|state| {
                    state.mode == ExecutionMode::Background
                        && matches!(statement, Statement::Scroll { .. })
                }) {
                    add_validation_error(
                        errors,
                        "This action is unsupported in strict background mode; no foreground fallback is performed",
                    );
                }
            }
            Statement::MouseDown(_)
            | Statement::MouseUp(_)
            | Statement::KeyDown(_)
            | Statement::KeyUp(_)
            | Statement::Press(_)
            | Statement::Type(_) => {
                if states
                    .iter()
                    .any(|state| state.mode == ExecutionMode::Background)
                {
                    add_validation_error(
                        errors,
                        "This action is unsupported in strict background mode; no foreground fallback is performed",
                    );
                }
            }
            Statement::Repeat { count, body } => {
                if *count > 0 {
                    let mut current = states.clone();
                    let mut seen = Vec::<Vec<ValidationState>>::new();
                    let mut iteration = 0u32;
                    while iteration < *count {
                        if let Some(cycle_start) = seen.iter().position(|prior| prior == &current) {
                            let cycle_length = iteration - cycle_start as u32;
                            let remainder = (*count - iteration) % cycle_length;
                            for _ in 0..remainder {
                                current = validate_statements(body, current, errors);
                            }
                            break;
                        }
                        seen.push(current.clone());
                        current = validate_statements(body, current, errors);
                        iteration += 1;
                    }
                    states = current;
                }
            }
            Statement::If {
                body, otherwise, ..
            } => {
                let when_true = validate_statements(body, states.clone(), errors);
                let when_false = validate_statements(otherwise, states, errors);
                states = merge_validation_states(when_true, when_false);
            }
            Statement::While { body, .. } => {
                let mut reachable = states.clone();
                loop {
                    let body_outputs = validate_statements(body, reachable.clone(), errors);
                    let expanded = merge_validation_states(reachable.clone(), body_outputs);
                    if expanded == reachable {
                        break;
                    }
                    reachable = expanded;
                }
                states = reachable;
            }
            _ => {}
        }
    }
    states
}

#[derive(Clone, Copy, Debug)]
enum Value {
    Integer(i64),
    Boolean(bool),
}

struct Execution {
    app: tauri::AppHandle,
    expected_generation: u64,
    selected_hwnd: Option<u64>,
    selected_pid: Option<u32>,
    target: Option<crate::target_window::TargetWindow>,
    safety_config: crate::engine::ClickerConfig,
    mode: ExecutionMode,
    variables: std::collections::HashMap<String, Value>,
    held_buttons: std::collections::HashSet<MouseButton>,
    held_keys: std::collections::HashSet<u16>,
    virtual_cursor: Option<(i32, i32)>,
    virtual_cursor_space: CoordinateSpace,
    random: crate::engine::rng::SmallRng,
    steps: usize,
    loop_iterations: usize,
    started: std::time::Instant,
    last_status_emit: std::time::Duration,
}

impl Execution {
    fn active(&self) -> bool {
        use std::sync::atomic::Ordering;
        let state = self.app.state::<crate::ClickerState>();
        state.running.load(Ordering::SeqCst)
            && state.run_generation.load(Ordering::SeqCst) == self.expected_generation
    }

    fn check_limits(&self) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        if !self.active() {
            return Err("Cancelled".into());
        }
        let state = self.app.state::<crate::ClickerState>();
        if !state.master_allowed.load(Ordering::SeqCst) {
            return Err("Stopped because the master switch is off.".into());
        }
        if self.started.elapsed() > std::time::Duration::from_secs(15 * 60) {
            return Err("Stopped by the 15-minute macro runtime limit.".into());
        }
        Ok(())
    }

    fn is_paused(&self) -> bool {
        use std::sync::atomic::Ordering;
        let state = self.app.state::<crate::ClickerState>();
        state.paused.load(Ordering::SeqCst)
    }

    fn check_input_policy(&self, proposed_position: Option<(i32, i32)>) -> Result<(), String> {
        self.check_input_policy_with_monitors(proposed_position, None)
    }

    fn check_input_policy_with_monitors(
        &self,
        proposed_position: Option<(i32, i32)>,
        monitor_snapshot: Option<&[crate::engine::mouse::VirtualScreenRect]>,
    ) -> Result<(), String> {
        self.wait_until_resumed()?;
        self.check_limits()?;
        if self.mode == ExecutionMode::Foreground {
            if crate::engine::process::check_process_list(&self.safety_config).is_some() {
                return Err(
                    "The foreground process is blocked by the configured process list.".into(),
                );
            }
            let check_failsafes = self.safety_config.stop_zones_enabled
                || self.safety_config.corner_stop_enabled
                || self.safety_config.edge_stop_enabled;
            if check_failsafes {
                let monitors = if self.safety_config.corner_stop_enabled
                    || self.safety_config.edge_stop_enabled
                {
                    Some(match monitor_snapshot {
                        Some(monitors) => std::borrow::Cow::Borrowed(monitors),
                        None => std::borrow::Cow::Owned(
                            crate::engine::mouse::current_monitor_rects().unwrap_or_default(),
                        ),
                    })
                } else {
                    None
                };
                if let Some(cursor) = crate::engine::mouse::current_cursor_position() {
                    if let Some(reason) = crate::engine::failsafe::detect_failsafe(
                        cursor,
                        monitors.as_deref().unwrap_or(&[]),
                        &self.safety_config,
                    ) {
                        return Err(reason);
                    }
                }
                if let Some(position) = proposed_position {
                    if let Some(reason) = crate::engine::failsafe::detect_failsafe(
                        position,
                        monitors.as_deref().unwrap_or(&[]),
                        &self.safety_config,
                    ) {
                        return Err(reason);
                    }
                }
            }
        } else if self.safety_config.process_list_enabled {
            let target_name = self
                .target
                .as_ref()
                .map(|target| target.process_name.as_str())
                .ok_or_else(|| "Choose a target before checking the process list.".to_string())?;
            let matched = self
                .safety_config
                .process_list_entries
                .iter()
                .any(|entry| entry.enabled && entry.name.eq_ignore_ascii_case(target_name));
            let blocked = match self.safety_config.process_list_mode {
                crate::engine::ProcessListMode::Whitelist => !matched,
                crate::engine::ProcessListMode::Blacklist => matched,
            };
            if blocked {
                return Err(format!(
                    "Target process {target_name:?} is blocked by the configured process list."
                ));
            }
        }
        Ok(())
    }

    fn wait(&self, duration_ms: u64) -> Result<(), String> {
        let mut remaining = std::time::Duration::from_millis(duration_ms);
        while !remaining.is_zero() {
            self.check_limits()?;
            if self.is_paused() {
                std::thread::sleep(std::time::Duration::from_millis(10));
                continue;
            }
            let slice = remaining.min(std::time::Duration::from_millis(10));
            let slice_started = std::time::Instant::now();
            std::thread::sleep(slice);
            // Scheduler delays must not shorten scripted waits. If pause was
            // requested during this slice, discard it so paused time is never
            // charged against the remaining duration.
            if !self.is_paused() {
                remaining = remaining.saturating_sub(slice_started.elapsed().min(slice));
            }
        }
        Ok(())
    }

    fn wait_until_resumed(&self) -> Result<(), String> {
        loop {
            self.check_limits()?;
            if !self.is_paused() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn ensure_action_supported_in_mode(&self, statement: &Statement) -> Result<(), String> {
        if self.mode == ExecutionMode::Background
            && matches!(
                statement,
                Statement::MouseDown(_)
                    | Statement::MouseUp(_)
                    | Statement::KeyDown(_)
                    | Statement::KeyUp(_)
                    | Statement::Press(_)
                    | Statement::Type(_)
                    | Statement::Scroll { .. }
            )
        {
            return Err("This action is unsupported in strict background mode; no foreground fallback is performed.".into());
        }
        Ok(())
    }

    fn emit_step(&mut self, command: &str) {
        use tauri::Emitter;
        self.steps += 1;
        if self.steps == 1
            || self.started.elapsed().saturating_sub(self.last_status_emit)
                >= std::time::Duration::from_millis(100)
        {
            self.last_status_emit = self.started.elapsed();
            let _ = self.app.emit(
                "macro:step",
                serde_json::json!({
                    "step": self.steps,
                    "command": command,
                    "elapsedMs": self.started.elapsed().as_millis() as u64,
                }),
            );
        }
    }

    fn evaluate(&self, expr: &Expr) -> Result<Value, String> {
        match expr {
            Expr::Integer(value) => Ok(Value::Integer(*value)),
            Expr::Boolean(value) => Ok(Value::Boolean(*value)),
            Expr::Variable(name) => self
                .variables
                .get(name)
                .copied()
                .ok_or_else(|| format!("Variable {name:?} is not defined.")),
            Expr::Add(left, right) => match (self.evaluate(left)?, self.evaluate(right)?) {
                (Value::Integer(a), Value::Integer(b)) => a
                    .checked_add(b)
                    .map(Value::Integer)
                    .ok_or_else(|| "Integer addition overflow.".into()),
                _ => Err("Addition requires integers.".into()),
            },
            Expr::Subtract(left, right) => match (self.evaluate(left)?, self.evaluate(right)?) {
                (Value::Integer(a), Value::Integer(b)) => a
                    .checked_sub(b)
                    .map(Value::Integer)
                    .ok_or_else(|| "Integer subtraction overflow.".into()),
                _ => Err("Subtraction requires integers.".into()),
            },
            Expr::Compare(op, left, right) => {
                let left = self.evaluate(left)?;
                let right = self.evaluate(right)?;
                let matched = match (left, right) {
                    (Value::Integer(a), Value::Integer(b)) => match op {
                        CompareOp::Eq => a == b,
                        CompareOp::Ne => a != b,
                        CompareOp::Lt => a < b,
                        CompareOp::Le => a <= b,
                        CompareOp::Gt => a > b,
                        CompareOp::Ge => a >= b,
                    },
                    (Value::Boolean(a), Value::Boolean(b)) => match op {
                        CompareOp::Eq => a == b,
                        CompareOp::Ne => a != b,
                        _ => return Err("Booleans only support == and !=.".into()),
                    },
                    _ => return Err("Cannot compare values of different types.".into()),
                };
                Ok(Value::Boolean(matched))
            }
            Expr::WindowExists { process } => {
                let found = crate::target_window::target_process_window_exists(process);
                Ok(Value::Boolean(found))
            }
        }
    }

    fn condition(&self, expr: &Expr) -> Result<bool, String> {
        match self.evaluate(expr)? {
            Value::Boolean(value) => Ok(value),
            Value::Integer(_) => Err("Condition must evaluate to true or false.".into()),
        }
    }

    fn resolve_target(&mut self, selector: &TargetSelector) -> Result<(), String> {
        let target = crate::target_window::resolve_target(selector, self.selected_hwnd)?;
        if self.selected_hwnd == Some(target.hwnd)
            && self.selected_pid.is_some_and(|pid| pid != target.pid)
        {
            return Err(
                "The selected window identity changed. Pick the target window again.".into(),
            );
        }
        self.target = Some(target);
        Ok(())
    }

    fn resolve_selected_target_if_needed(&mut self) -> Result<(), String> {
        let hwnd = match self.target.as_ref() {
            Some(target) => target.hwnd,
            None => self.selected_hwnd.ok_or_else(|| {
                "Client coordinates require a selected target window.".to_string()
            })?,
        };
        let current = crate::target_window::resolve_selected_target(hwnd)?;
        let identity_changed = self.target.as_ref().is_some_and(|target| {
            target.pid != current.pid
                || !target
                    .process_name
                    .eq_ignore_ascii_case(&current.process_name)
        }) || (self.selected_hwnd == Some(current.hwnd)
            && self.selected_pid.is_some_and(|pid| pid != current.pid));
        if identity_changed {
            return Err("Target window identity changed; pick it again.".into());
        }
        self.target = Some(current);
        Ok(())
    }

    fn ensure_background_target(&mut self) -> Result<crate::target_window::TargetWindow, String> {
        let target = self
            .target
            .clone()
            .ok_or_else(|| "Choose a target window before using background mode.".to_string())?;
        let current = crate::target_window::resolve_selected_target(target.hwnd)?;
        if current.pid != target.pid
            || !current
                .process_name
                .eq_ignore_ascii_case(&target.process_name)
        {
            return Err("Target window identity changed; pick it again.".into());
        }
        self.target = Some(current.clone());
        Ok(current)
    }

    fn screen_coordinates(
        &mut self,
        x: i32,
        y: i32,
        space: CoordinateSpace,
    ) -> Result<(i32, i32), String> {
        match space {
            CoordinateSpace::Screen => Ok((x, y)),
            CoordinateSpace::Client => {
                self.resolve_selected_target_if_needed()?;
                let target = self.target.as_ref().ok_or_else(|| {
                    "Client coordinates require a selected target window.".to_string()
                })?;
                crate::target_window::client_to_screen(target.hwnd, x, y)
            }
        }
    }

    fn move_foreground(
        &mut self,
        x: i32,
        y: i32,
        space: CoordinateSpace,
        duration_ms: u64,
    ) -> Result<(), String> {
        self.wait_until_resumed()?;
        let (x, y) = self.screen_coordinates(x, y, space)?;
        let start = crate::engine::mouse::current_cursor_position().unwrap_or((x, y));
        let steps = (duration_ms.saturating_add(7) / 8).clamp(1, 100);
        let mut elapsed_ms = 0u64;
        for step in 1..=steps {
            self.check_limits()?;
            let target_elapsed_ms =
                (u128::from(duration_ms) * u128::from(step) / u128::from(steps)) as u64;
            self.wait(target_elapsed_ms.saturating_sub(elapsed_ms))?;
            elapsed_ms = target_elapsed_ms;
            let fraction = step as f64 / steps as f64;
            let next_x = (f64::from(start.0) + (f64::from(x) - f64::from(start.0)) * fraction)
                .round() as i32;
            let next_y = (f64::from(start.1) + (f64::from(y) - f64::from(start.1)) * fraction)
                .round() as i32;
            let monitors = crate::engine::mouse::current_monitor_rects().unwrap_or_default();
            if !monitors.is_empty() && !monitors.iter().any(|monitor| monitor.contains(x, y)) {
                return Err("Foreground coordinates must lie on a connected monitor.".into());
            }
            self.check_input_policy_with_monitors(Some((next_x, next_y)), Some(&monitors))?;
            crate::engine::mouse::try_move_mouse(next_x, next_y)?;
        }
        Ok(())
    }

    fn move_background(
        &mut self,
        x: i32,
        y: i32,
        space: CoordinateSpace,
        duration_ms: u64,
    ) -> Result<(), String> {
        let start = self
            .virtual_cursor
            .filter(|_| self.virtual_cursor_space == space);
        let steps = if duration_ms == 0 || start.is_none() {
            1
        } else {
            (duration_ms.saturating_add(7) / 8).clamp(1, 100)
        };
        let mut elapsed_ms = 0u64;
        for step in 1..=steps {
            let target_elapsed_ms =
                (u128::from(duration_ms) * u128::from(step) / u128::from(steps)) as u64;
            self.wait(target_elapsed_ms.saturating_sub(elapsed_ms))?;
            elapsed_ms = target_elapsed_ms;
            self.check_input_policy(None)?;
            let position = if let Some((start_x, start_y)) = start {
                let fraction = step as f64 / steps as f64;
                (
                    (f64::from(start_x) + (f64::from(x) - f64::from(start_x)) * fraction).round()
                        as i32,
                    (f64::from(start_y) + (f64::from(y) - f64::from(start_y)) * fraction).round()
                        as i32,
                )
            } else {
                (x, y)
            };
            let target = self.ensure_background_target()?;
            crate::target_window::background_move(
                &target,
                position.0,
                position.1,
                if space == CoordinateSpace::Screen {
                    "screen"
                } else {
                    "client"
                },
            )?;
            self.virtual_cursor = Some(position);
            self.virtual_cursor_space = space;
        }
        Ok(())
    }

    fn execute(&mut self, statements: &[Statement]) -> Result<(), String> {
        for statement in statements {
            self.wait_until_resumed()?;
            if self.steps >= MAX_STATEMENTS {
                return Err(format!(
                    "Stopped by the {MAX_STATEMENTS}-step execution limit."
                ));
            }
            self.ensure_action_supported_in_mode(statement)?;
            let command = match statement {
                Statement::Target(_) => "target",
                Statement::Mode { .. } => "mode",
                Statement::Move { .. } => "move",
                Statement::Click { .. } => "click",
                Statement::MouseDown(_) => "mouse_down",
                Statement::MouseUp(_) => "mouse_up",
                Statement::KeyDown(_) => "key_down",
                Statement::KeyUp(_) => "key_up",
                Statement::Press(_) => "press",
                Statement::Type(_) => "type",
                Statement::Scroll { .. } => "scroll",
                Statement::Wait(_) => "wait",
                Statement::Let { .. } => "let",
                Statement::Set { .. } => "set",
                Statement::Repeat { .. } => "repeat",
                Statement::While { .. } => "while",
                Statement::If { .. } => "if",
                Statement::Log(_) => "log",
            };
            self.emit_step(command);
            match statement {
                Statement::Target(selector) => self.resolve_target(selector)?,
                Statement::Mode { mode, strict } => {
                    if *mode == ExecutionMode::Background && !strict {
                        return Err("Background mode requires strict=true.".into());
                    }
                    if *mode != self.mode {
                        if !self.held_buttons.is_empty() || !self.held_keys.is_empty() {
                            return Err(
                                "Cannot change execution mode while mouse buttons or keys are held."
                                    .into(),
                            );
                        }
                        // A cursor position belongs to its execution mode; do not turn a
                        // background virtual position into a real foreground click.
                        self.virtual_cursor = None;
                        self.virtual_cursor_space = CoordinateSpace::Screen;
                    }
                    self.mode = *mode;
                }
                Statement::Move {
                    x,
                    y,
                    space,
                    duration_ms,
                } => {
                    if self.mode == ExecutionMode::Background {
                        self.move_background(*x, *y, *space, *duration_ms)?;
                    } else {
                        self.move_foreground(*x, *y, *space, *duration_ms)?;
                        self.virtual_cursor = Some((*x, *y));
                        self.virtual_cursor_space = *space;
                    }
                }
                Statement::Click {
                    button,
                    x,
                    y,
                    space,
                    count,
                    radius,
                } => {
                    if *count == 0 || *count > 10_000 {
                        return Err("click count must be from 1 to 10000.".into());
                    }
                    if *radius > i32::MAX as u32 {
                        return Err(
                            "click radius must fit a signed 32-bit coordinate range.".into()
                        );
                    }
                    let (origin, click_space) = match (x, y) {
                        (Some(x), Some(y)) => ((*x, *y), *space),
                        _ => {
                            let position = match self.mode {
                                ExecutionMode::Background => self.virtual_cursor,
                                ExecutionMode::Foreground => self
                                    .virtual_cursor
                                    .or_else(crate::engine::mouse::current_cursor_position),
                            };
                            (
                                position.ok_or_else(|| {
                                    "Move to a coordinate before clicking.".to_string()
                                })?,
                                self.virtual_cursor_space,
                            )
                        }
                    };
                    let (down, up) = mouse_flags(button);
                    for _ in 0..*count {
                        self.check_limits()?;
                        let offset = if *radius == 0 {
                            (0, 0)
                        } else {
                            let angle = self.random.next_f64() * std::f64::consts::TAU;
                            let distance = self.random.next_f64().sqrt() * *radius as f64;
                            (
                                (angle.cos() * distance).round() as i32,
                                (angle.sin() * distance).round() as i32,
                            )
                        };
                        let point = (
                            origin
                                .0
                                .checked_add(offset.0)
                                .ok_or_else(|| "click x coordinate overflowed.".to_string())?,
                            origin
                                .1
                                .checked_add(offset.1)
                                .ok_or_else(|| "click y coordinate overflowed.".to_string())?,
                        );
                        if self.mode == ExecutionMode::Background {
                            self.check_input_policy(None)?;
                            let target = self.ensure_background_target()?;
                            crate::target_window::background_click(
                                &target,
                                point.0,
                                point.1,
                                if click_space == CoordinateSpace::Screen {
                                    "screen"
                                } else {
                                    "client"
                                },
                                button_name(button),
                                1,
                            )?;
                        } else {
                            self.move_foreground(point.0, point.1, click_space, 0)?;
                            crate::engine::mouse::try_send_mouse_event(down)?;
                            self.held_buttons.insert(button.clone());
                            crate::engine::mouse::try_send_mouse_event(up)?;
                            self.held_buttons.remove(button);
                        }
                        self.virtual_cursor = Some(point);
                        self.virtual_cursor_space = click_space;
                        if *count > 1 {
                            self.wait(2)?;
                        }
                    }
                }
                Statement::MouseDown(button) => {
                    self.check_input_policy(None)?;
                    let (down, _) = mouse_flags(button);
                    crate::engine::mouse::try_send_mouse_event(down)?;
                    self.held_buttons.insert(button.clone());
                }
                Statement::MouseUp(button) => {
                    self.check_input_policy(None)?;
                    let (_, up) = mouse_flags(button);
                    crate::engine::mouse::try_send_mouse_event(up)?;
                    self.held_buttons.remove(button);
                }
                Statement::KeyDown(key) => {
                    self.check_input_policy(None)?;
                    let vk = key_code(key)?;
                    crate::engine::keyboard::try_send_key_event(vk, 0)?;
                    self.held_keys.insert(vk);
                }
                Statement::KeyUp(key) => {
                    self.check_input_policy(None)?;
                    let vk = key_code(key)?;
                    crate::engine::keyboard::try_send_key_event(
                        vk,
                        windows_sys::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP,
                    )?;
                    self.held_keys.remove(&vk);
                }
                Statement::Press(chord) => self.press(chord)?,
                Statement::Type(text) => self.type_text(text)?,
                Statement::Scroll { delta, x, y, space } => {
                    let position = match (x, y) {
                        (Some(x), Some(y)) => Some((*x, *y, *space)),
                        _ => self
                            .virtual_cursor
                            .map(|(x, y)| (x, y, self.virtual_cursor_space)),
                    };
                    let screen_position = position
                        .map(|(x, y, space)| self.screen_coordinates(x, y, space))
                        .transpose()?;
                    self.check_input_policy(screen_position)?;
                    if let Some((screen_x, screen_y)) = screen_position {
                        self.move_foreground(screen_x, screen_y, CoordinateSpace::Screen, 0)?;
                        if let Some((x, y, space)) = position {
                            self.virtual_cursor = Some((x, y));
                            self.virtual_cursor_space = space;
                        }
                    }
                    send_scroll(*delta)?;
                }
                Statement::Wait(duration_ms) => self.wait(*duration_ms)?,
                Statement::Let { name, value } => {
                    if self.variables.contains_key(name) {
                        return Err(format!("Variable {name:?} is already defined."));
                    }
                    self.variables.insert(name.clone(), self.evaluate(value)?);
                }
                Statement::Set { name, value } => {
                    if !self.variables.contains_key(name) {
                        return Err(format!("Variable {name:?} is not defined."));
                    }
                    let value = self.evaluate(value)?;
                    self.variables.insert(name.clone(), value);
                }
                Statement::Repeat { count, body } => {
                    for _ in 0..*count {
                        self.bump_loop()?;
                        self.execute(body)?;
                    }
                }
                Statement::While { condition, body } => {
                    while self.condition(condition)? {
                        self.bump_loop()?;
                        self.execute(body)?;
                    }
                }
                Statement::If {
                    condition,
                    body,
                    otherwise,
                } => {
                    if self.condition(condition)? {
                        self.execute(body)?;
                    } else {
                        self.execute(otherwise)?;
                    }
                }
                Statement::Log(message) => {
                    use tauri::Emitter;
                    let _ = self.app.emit(
                        "macro:log",
                        serde_json::json!({
                            "message": message.chars().take(500).collect::<String>(),
                            "elapsedMs": self.started.elapsed().as_millis() as u64,
                        }),
                    );
                }
            }
        }
        Ok(())
    }

    fn bump_loop(&mut self) -> Result<(), String> {
        self.wait_until_resumed()?;
        self.loop_iterations += 1;
        if self.loop_iterations > 100_000 {
            return Err("Stopped by the 100000-iteration macro watchdog.".into());
        }
        self.check_limits()
    }

    fn press(&mut self, chord: &str) -> Result<(), String> {
        let keys = chord
            .split('+')
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return Err("press requires at least one key.".into());
        }
        let mut newly_pressed = Vec::new();
        for key in &keys {
            self.check_input_policy(None)?;
            let vk = key_code(key)?;
            if self.held_keys.contains(&vk) {
                continue;
            }
            crate::engine::keyboard::try_send_key_event(vk, 0)?;
            self.held_keys.insert(vk);
            newly_pressed.push(vk);
        }
        for vk in newly_pressed.iter().rev() {
            if self.held_keys.contains(vk) {
                crate::engine::keyboard::try_send_key_event(
                    *vk,
                    windows_sys::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP,
                )?;
                self.held_keys.remove(vk);
            }
        }
        Ok(())
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        if text.encode_utf16().count() > 10_000 {
            return Err("type text is limited to 10000 UTF-16 code units per statement.".into());
        }
        for unit in text.encode_utf16() {
            self.check_input_policy(None)?;
            type_unicode_unit(unit)?;
        }
        Ok(())
    }

    fn release_all(&mut self) -> Vec<String> {
        let mut errors = Vec::new();
        let buttons = self.held_buttons.iter().cloned().collect::<Vec<_>>();
        for button in buttons {
            let (_, up) = mouse_flags(&button);
            match crate::engine::mouse::try_send_mouse_event(up) {
                Ok(()) => {
                    self.held_buttons.remove(&button);
                }
                Err(error) => errors.push(format!("mouse button release failed: {error}")),
            }
        }
        let keys = self.held_keys.iter().copied().collect::<Vec<_>>();
        for vk in keys {
            match crate::engine::keyboard::try_send_key_event(
                vk,
                windows_sys::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP,
            ) {
                Ok(()) => {
                    self.held_keys.remove(&vk);
                }
                Err(error) => errors.push(format!("key release failed: {error}")),
            }
        }
        errors
    }
}

impl Drop for Execution {
    fn drop(&mut self) {
        let _ = self.release_all();
    }
}

fn button_name(button: &MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

fn mouse_flags(button: &MouseButton) -> (u32, u32) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    };
    match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

fn key_code(key: &str) -> Result<u16, String> {
    let key = key.trim().to_uppercase();
    let named = match key.as_str() {
        "CTRL" | "CONTROL" => Some(0x11),
        "LEFTCTRL" | "LCTRL" => Some(0xA2),
        "RIGHTCTRL" | "RCTRL" => Some(0xA3),
        "ALT" => Some(0x12),
        "LEFTALT" | "LALT" => Some(0xA4),
        "RIGHTALT" | "RALT" => Some(0xA5),
        "SHIFT" => Some(0x10),
        "LEFTSHIFT" | "LSHIFT" => Some(0xA0),
        "RIGHTSHIFT" | "RSHIFT" => Some(0xA1),
        "WIN" | "META" | "LEFTWIN" => Some(0x5B),
        "RIGHTWIN" => Some(0x5C),
        "ENTER" | "RETURN" => Some(0x0D),
        "ESC" | "ESCAPE" => Some(0x1B),
        "SPACE" => Some(0x20),
        "TAB" => Some(0x09),
        "BACKSPACE" => Some(0x08),
        "DELETE" | "DEL" => Some(0x2E),
        "INSERT" => Some(0x2D),
        "HOME" => Some(0x24),
        "END" => Some(0x23),
        "PAGEUP" | "PGUP" => Some(0x21),
        "PAGEDOWN" | "PGDN" => Some(0x22),
        "UP" => Some(0x26),
        "DOWN" => Some(0x28),
        "LEFT" => Some(0x25),
        "RIGHT" => Some(0x27),
        "CAPSLOCK" => Some(0x14),
        "NUMLOCK" => Some(0x90),
        "SCROLLLOCK" => Some(0x91),
        "PRINTSCREEN" => Some(0x2C),
        "PAUSE" => Some(0x13),
        "BACKTICK" => Some(0xC0),
        "APPS" => Some(0x5D),
        "SLEEP" => Some(0x5F),
        "MULTIPLY" => Some(0x6A),
        "ADD" => Some(0x6B),
        "SEPARATOR" => Some(0x6C),
        "SUBTRACT" => Some(0x6D),
        "DECIMAL" => Some(0x6E),
        "DIVIDE" => Some(0x6F),
        _ => None,
    };
    if let Some(vk) = named {
        return Ok(vk);
    }
    if key.len() == 1 {
        let byte = key.as_bytes()[0];
        if byte.is_ascii_alphanumeric() {
            return Ok(byte as u16);
        }
        let punctuation = match byte {
            b';' => 0xBA,
            b'=' => 0xBB,
            b',' => 0xBC,
            b'-' => 0xBD,
            b'.' => 0xBE,
            b'/' => 0xBF,
            b'[' => 0xDB,
            b'\\' => 0xDC,
            b']' => 0xDD,
            b'\'' => 0xDE,
            _ => 0,
        };
        if punctuation != 0 {
            return Ok(punctuation);
        }
    }
    if let Some(suffix) = key.strip_prefix('F') {
        if let Ok(number) = suffix.parse::<u16>() {
            if (1..=24).contains(&number) {
                return Ok(0x70 + number - 1);
            }
        }
    }
    if let Some(suffix) = key.strip_prefix("NUMPAD") {
        if let Ok(number) = suffix.parse::<u16>() {
            if number <= 9 {
                return Ok(0x60 + number);
            }
        }
    }
    Err(format!("Unsupported key name {key:?}."))
}

#[cfg(windows)]
fn type_unicode_unit(unit: u16) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    };
    let mut inputs: [INPUT; 2] = unsafe { std::mem::zeroed() };
    for (index, flags) in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP]
        .into_iter()
        .enumerate()
    {
        inputs[index] = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: 0,
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: crate::engine::AUTOCLICKER_EXTRA_INFO,
                },
            },
        };
    }
    let accepted = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if accepted != inputs.len() as u32 {
        return Err("Windows did not accept all Unicode text input.".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn type_unicode_unit(_unit: u16) -> Result<(), String> {
    Err("Unicode input is only supported on Windows.".into())
}

#[cfg(windows)]
fn send_scroll(delta: i32) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: delta as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: crate::engine::AUTOCLICKER_EXTRA_INFO,
            },
        },
    };
    let accepted = unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) };
    if accepted == 1 {
        Ok(())
    } else {
        Err("Windows did not accept the scroll input.".into())
    }
}

#[cfg(not(windows))]
fn send_scroll(_delta: i32) -> Result<(), String> {
    Err("Scroll input is only supported on Windows.".into())
}

pub fn start_macro_inner(
    app: &tauri::AppHandle,
) -> crate::error::AppResult<crate::ClickerStatusPayload> {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;
    use tauri::Manager;

    let state = app.state::<crate::ClickerState>();
    if state.recording_active.load(Ordering::SeqCst) {
        return Err(crate::error::AppError::AlreadyRunning);
    }
    if !state.master_allowed.load(Ordering::SeqCst) {
        return Err(crate::error::AppError::State(
            "The master switch is off.".into(),
        ));
    }
    let source = state
        .macro_source
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .clone();
    let selected_hwnd = *state
        .macro_target_hwnd
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner);
    let selected_pid = *state
        .macro_target_pid
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner);
    let safety_config = {
        let settings = state
            .settings
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner);
        crate::engine::worker::build_config(&settings)
            .map_err(|error| crate::error::AppError::State(format!("Invalid settings: {error}")))?
    };
    let (program, statement_count) = parse_program(&source).map_err(|error| {
        crate::error::AppError::State(format!(
            "Line {}, column {}: {}",
            error.line, error.column, error.message
        ))
    })?;
    let validation = validate_program(&program, statement_count);
    if !validation.ok {
        let first = &validation.errors[0];
        return Err(crate::error::AppError::State(format!(
            "Line {}, column {}: {}",
            first.line, first.column, first.message
        )));
    }
    let needs_background = contains_background(&program.statements);
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(crate::error::AppError::AlreadyRunning);
    }
    if state.recording_active.load(Ordering::SeqCst) {
        state.running.store(false, Ordering::SeqCst);
        return Err(crate::error::AppError::AlreadyRunning);
    }
    let expected_generation = state.run_generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.active_job_is_macro.store(true, Ordering::SeqCst);
    state.paused.store(false, Ordering::SeqCst);
    state.active_click_point_index.store(-1, Ordering::SeqCst);
    *state
        .last_error
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = None;
    *state
        .stop_reason
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = None;
    *state
        .warning
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = if needs_background {
        Some(
            "This macro may queue background messages; Windows cannot confirm the target effect."
                .into(),
        )
    } else {
        None
    };

    let payload = crate::engine::worker::current_status(app);
    crate::icon::set_app_icons(app);
    crate::engine::worker::emit_status(app);
    let mut execution = Execution {
        app: app.clone(),
        expected_generation,
        selected_hwnd,
        selected_pid,
        target: None,
        safety_config,
        mode: ExecutionMode::Foreground,
        variables: std::collections::HashMap::new(),
        held_buttons: std::collections::HashSet::new(),
        held_keys: std::collections::HashSet::new(),
        virtual_cursor: None,
        virtual_cursor_space: CoordinateSpace::Screen,
        random: crate::engine::rng::SmallRng::new(),
        steps: 0,
        loop_iterations: 0,
        started: std::time::Instant::now(),
        last_status_emit: std::time::Duration::ZERO,
    };
    let app_handle = app.clone();
    let _ = app.emit("macro:state", serde_json::json!({ "state": "Running" }));
    let preserve_background_warning = needs_background;
    std::thread::Builder::new()
        .name("blur-macro-runtime".into())
        .spawn(move || {
            let mut result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                execution.execute(&program.statements)
            }))
            .unwrap_or_else(|_| Err("Macro stopped after an internal runtime error.".into()));
            let release_errors = execution.release_all();
            if !release_errors.is_empty() {
                let release_error = format!(
                    "Could not release all simulated input: {}",
                    release_errors.join(" ")
                );
                log::error!("{release_error}");
                result = match result {
                    Err(previous_error) if previous_error != "Cancelled" => {
                        Err(format!("{previous_error} {release_error}"))
                    }
                    _ => Err(release_error),
                };
            }
            if !execution.active() {
                return;
            }
            let state = app_handle.state::<crate::ClickerState>();
            state.running.store(false, Ordering::SeqCst);
            state.active_job_is_macro.store(false, Ordering::SeqCst);
            state.paused.store(false, Ordering::SeqCst);
            *state
                .warning
                .lock()
                .unwrap_or_else(crate::error::poisoned_inner) =
                if preserve_background_warning {
                    Some(
                        "This macro may queue background messages; Windows cannot confirm the target effect."
                            .into(),
                    )
                } else {
                    None
                };
            let cancelled = matches!(result, Err(ref error) if error == "Cancelled");
            match result {
                Ok(()) => {
                    *state
                        .stop_reason
                        .lock()
                        .unwrap_or_else(crate::error::poisoned_inner) =
                        Some("Macro completed.".into());
                    *state
                        .last_error
                        .lock()
                        .unwrap_or_else(crate::error::poisoned_inner) = None;
                    let _ = app_handle.emit(
                        "macro:state",
                        serde_json::json!({ "state": "Completed", "steps": execution.steps }),
                    );
                }
                Err(_error) if cancelled => {
                    *state
                        .stop_reason
                        .lock()
                        .unwrap_or_else(crate::error::poisoned_inner) =
                        Some("Macro cancelled.".into());
                    let _ = app_handle.emit(
                        "macro:state",
                        serde_json::json!({ "state": "Cancelled", "steps": execution.steps }),
                    );
                }
                Err(error) => {
                    *state
                        .last_error
                        .lock()
                        .unwrap_or_else(crate::error::poisoned_inner) = Some(error.clone());
                    *state
                        .stop_reason
                        .lock()
                        .unwrap_or_else(crate::error::poisoned_inner) =
                        Some("Macro failed.".into());
                    let _ = app_handle.emit(
                        "macro:error",
                        serde_json::json!({ "message": error, "steps": execution.steps }),
                    );
                    let _ = app_handle.emit(
                        "macro:state",
                        serde_json::json!({ "state": "Error", "steps": execution.steps }),
                    );
                }
            }
            crate::icon::set_app_icons(&app_handle);
            crate::engine::worker::emit_status(&app_handle);
        })
        .map_err(|error| {
            let message = format!("Failed to start macro worker: {error}");
            state.running.store(false, Ordering::SeqCst);
            state.active_job_is_macro.store(false, Ordering::SeqCst);
            state.paused.store(false, Ordering::SeqCst);
            state.active_click_point_index.store(-1, Ordering::SeqCst);
            state.active_click_point_tick.store(0, Ordering::SeqCst);
            *state
                .last_error
                .lock()
                .unwrap_or_else(crate::error::poisoned_inner) = Some(message.clone());
            *state
                .warning
                .lock()
                .unwrap_or_else(crate::error::poisoned_inner) = None;
            let _ = app.emit(
                "macro:state",
                serde_json::json!({ "state": "Error", "steps": 0 }),
            );
            crate::icon::set_app_icons(app);
            crate::engine::worker::emit_status(app);
            crate::error::AppError::State(message)
        })?;

    Ok(payload)
}

fn contains_background(statements: &[Statement]) -> bool {
    statements.iter().any(|statement| match statement {
        Statement::Mode {
            mode: ExecutionMode::Background,
            ..
        } => true,
        Statement::Repeat { count: 0, .. } => false,
        Statement::Repeat { body, .. } | Statement::While { body, .. } => contains_background(body),
        Statement::If {
            body, otherwise, ..
        } => contains_background(body) || contains_background(otherwise),
        _ => false,
    })
}

pub fn set_macro_context(
    app: &tauri::AppHandle,
    active: bool,
    source: String,
    selected_hwnd: Option<u64>,
    selected_pid: Option<u32>,
) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let state = app.state::<crate::ClickerState>();
    *state
        .macro_source
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = source;
    *state
        .macro_target_hwnd
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = selected_hwnd;
    *state
        .macro_target_pid
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = selected_pid;
    state.macro_mode_active.store(active, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE_A: &str = r#"# This is a Blur Macro Script v1 example.
target process="notepad.exe" title_contains="Notepad"
mode foreground
let completed = 0
repeat 3 {
  move x=300 y=240 space=screen duration=100ms
  click button=left x=300 y=240 space=screen count=1 radius=0
  wait 250ms
  press "CTRL+A"
  type "Hello from Blur Macro!"
  set completed = completed + 1
}
if completed == 3 {
  log "Completed 3 iterations"
} else {
  log "Unexpected count"
}"#;

    const EXAMPLE_B: &str = r#"# The target must be a compatible Windows window/control.
target process="notepad.exe" title_contains="Notepad"
mode background strict=true
move x=140 y=90 space=client
click button=left x=140 y=90 space=client count=1 radius=0
wait 150ms
log "Background click dispatched; verify target effect separately""#;

    const EXAMPLE_C: &str = r#"mode foreground
let i = 0
while i < 4 {
  move x=100 y=100 space=screen duration=50ms
  mouse_down button=left
  move x=500 y=100 space=screen duration=500ms
  mouse_up button=left
  wait 500ms
  set i = i + 1
}"#;

    #[test]
    fn parses_all_spec_examples() {
        assert!(
            validate_source(EXAMPLE_A).ok,
            "{:?}",
            validate_source(EXAMPLE_A).errors
        );
        assert!(
            validate_source(EXAMPLE_B).ok,
            "{:?}",
            validate_source(EXAMPLE_B).errors
        );
        assert!(
            validate_source(EXAMPLE_C).ok,
            "{:?}",
            validate_source(EXAMPLE_C).errors
        );
    }

    #[test]
    fn rejects_statements_inline_with_a_block_header() {
        let validation = validate_source("repeat 2 { click x=1 y=2 }");

        assert!(!validation.ok);
        assert!(validation.errors[0].message.contains("Expected a newline"));
    }

    #[test]
    fn rejects_unknown_commands_and_options_with_locations() {
        let unknown_command = validate_source("wait 1s\nlaunch shell");
        assert!(!unknown_command.ok);
        assert_eq!(unknown_command.errors[0].line, 2);
        let unknown_option = validate_source("click x=1 y=2 surprise=true");
        assert!(!unknown_option.ok);
    }

    #[test]
    fn rejects_unbalanced_blocks_and_bad_strings() {
        assert!(!validate_source("repeat 2 {\nwait 1s").ok);
        assert!(!validate_source("log \"bad\\q\"").ok);
    }

    #[test]
    fn rejects_expressions_that_exceed_recursion_limits() {
        let allowed_nesting = MAX_EXPRESSION_NESTING;
        let nested_condition = format!(
            "if {}true{} {{\nwait 1ms\n}}",
            "(".repeat(allowed_nesting),
            ")".repeat(allowed_nesting)
        );
        assert!(validate_source(&nested_condition).ok);

        let nesting = MAX_EXPRESSION_NESTING + 1;
        let deeply_nested_condition = format!(
            "if {}true{} {{\nwait 1ms\n}}",
            "(".repeat(nesting),
            ")".repeat(nesting)
        );
        let nesting_validation = validate_source(&deeply_nested_condition);
        assert!(!nesting_validation.ok);
        assert!(nesting_validation.errors[0]
            .message
            .contains("Expression nesting"));

        let allowed_terms = vec!["1"; MAX_EXPRESSION_NODES + 1].join(" + ");
        assert!(validate_source(&format!("let total = {allowed_terms}")).ok);

        let terms = vec!["1"; MAX_EXPRESSION_NODES + 2].join(" + ");
        let node_validation = validate_source(&format!("let total = {terms}"));
        assert!(!node_validation.ok);
        assert!(node_validation.errors[0]
            .message
            .contains("Expression exceeds"));
    }

    #[test]
    fn background_requires_target_strictness_and_supported_action() {
        assert!(!validate_source("mode background strict=true\nclick x=2 y=3").ok);
        assert!(!validate_source("target process=\"a.exe\"\nmode background\nclick x=2 y=3").ok);
        assert!(
            !validate_source(
                "target process=\"a.exe\"\nmode background strict=true\npress \"CTRL+A\""
            )
            .ok
        );
    }
}
