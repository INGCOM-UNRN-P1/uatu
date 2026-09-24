/**
 * Mock mínimo de la API `vscode` para probar el controlador fuera del
 * editor. Se instala interceptando Module._load antes de cargar los
 * módulos de src/vscode.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');

type Listener<T> = (e: T) => void;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  public event = (listener: Listener<T>, _thisArg?: unknown, disposables?: { dispose(): void }[]) => {
    this.listeners.push(listener);
    const d = { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
    disposables?.push(d);
    return d;
  };
  public fire(e: T): void {
    [...this.listeners].forEach((l) => l(e));
  }
}

class Uri {
  constructor(public readonly scheme: string, public readonly fsPath: string) {}
  get path() {
    return this.fsPath;
  }
  static file(p: string) {
    return new Uri('file', p);
  }
  static parse(s: string) {
    return s.startsWith('file://') ? new Uri('file', s.slice('file://'.length)) : new Uri(s.split(':')[0], s);
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri(base.scheme, path.join(base.fsPath, ...parts));
  }
  toString() {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export interface MockState {
  folders: { uri: Uri; name: string; index: number }[];
  focused: boolean;
  clipboard: string;
  acceptDisclaimer: boolean;
  githubLogin: string;
  messages: { level: string; text: string }[];
  statusTexts: string[];
  statusMessages: string[];
  extensions: { id: string; isActive: boolean; packageJSON: { version: string } }[];
}

export const state: MockState = {
  folders: [],
  focused: true,
  clipboard: '',
  acceptDisclaimer: true,
  githubLogin: 'octocat',
  messages: [],
  statusTexts: [],
  statusMessages: [],
  extensions: [],
};

export const events = {
  changeText: new EventEmitter<any>(),
  saveText: new EventEmitter<any>(),
  windowState: new EventEmitter<any>(),
  extensionsChange: new EventEmitter<void>(),
  folders: new EventEmitter<void>(),
};

function statusItem() {
  let text = '';
  return {
    name: '',
    command: '',
    tooltip: '',
    backgroundColor: undefined,
    get text() {
      return text;
    },
    set text(v: string) {
      text = v;
      state.statusTexts.push(v);
    },
    show() {},
    dispose() {},
  };
}

export const vscodeMock: any = {
  version: '1.90.0-mock',
  Uri,
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  RelativePattern: class {
    constructor(public base: unknown, public pattern: string) {}
  },
  window: {
    get state() {
      return { focused: state.focused };
    },
    activeTextEditor: undefined,
    createStatusBarItem: () => statusItem(),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showWarningMessage: async (text: string, ...items: any[]) => {
      state.messages.push({ level: 'warning', text });
      const opts = items[0];
      if (opts && typeof opts === 'object' && 'modal' in opts) {
        const choices = items.slice(1);
        return state.acceptDisclaimer ? choices[0] : choices.find((c: any) => c.isCloseAffordance);
      }
      return undefined;
    },
    showInformationMessage: async (text: string) => {
      state.messages.push({ level: 'info', text });
      return undefined;
    },
    showErrorMessage: async (text: string) => {
      state.messages.push({ level: 'error', text });
      return undefined;
    },
    setStatusBarMessage: (text: string) => {
      state.statusMessages.push(text);
      return { dispose() {} };
    },
    onDidChangeWindowState: events.windowState.event,
  },
  workspace: {
    get workspaceFolders() {
      return state.folders;
    },
    createFileSystemWatcher: () => {
      const e = new EventEmitter<any>();
      return { onDidCreate: e.event, onDidChange: e.event, onDidDelete: e.event, dispose() {} };
    },
    onDidChangeTextDocument: events.changeText.event,
    onDidSaveTextDocument: events.saveText.event,
    onDidChangeWorkspaceFolders: events.folders.event,
  },
  authentication: {
    getSession: async () => ({ account: { label: state.githubLogin, id: '1' }, accessToken: 't', id: 's', scopes: [] }),
  },
  extensions: {
    get all() {
      return state.extensions;
    },
    onDidChange: events.extensionsChange.event,
  },
  env: {
    clipboard: { readText: async () => state.clipboard },
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
};

let installed = false;
export function installVscodeMock(): void {
  if (installed) {
    return;
  }
  installed = true;
  const originalLoad = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad.call(this, request, ...rest);
  };
}

export function makeFolder(fsPath: string) {
  return { uri: Uri.file(fsPath), name: path.basename(fsPath), index: 0 };
}

export function fileUri(fsPath: string) {
  return Uri.file(fsPath);
}

export function makeSecrets() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k),
    store: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    onDidChange: new EventEmitter<any>().event,
    raw: m,
  };
}
