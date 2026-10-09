export interface MacroTarget {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
  className: string;
  visible: boolean;
  minimized: boolean;
  clientWidth: number;
  clientHeight: number;
  dpi: number;
}

export interface MacroProfile {
  id: string;
  name: string;
  source: string;
  syntaxVersion: 1;
  target: MacroTarget | null;
  createdAt: string;
  updatedAt: string;
  sourcePresetId?: string;
}

export interface MacroValidation {
  ok: boolean;
  statementCount: number;
  errors: Array<{ line: number; column: number; message: string }>;
}

export interface MacroStepEvent {
  step: number;
  command: string;
  elapsedMs: number;
}

export interface RecorderEvent {
  atMs: number;
  kind: string;
  x?: number;
  y?: number;
  delta?: number;
  button?: string;
  key?: string;
}
