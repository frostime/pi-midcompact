declare module "@earendil-works/pi-ai" {
  export const Type: {
    Object(value: unknown, options?: unknown): unknown;
    Array(value: unknown, options?: unknown): unknown;
    Union(value: unknown[]): unknown;
    Literal(value: string, options?: unknown): unknown;
    Optional(value: unknown): unknown;
    String(options?: unknown): unknown;
    Number(options?: unknown): unknown;
  };
  export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): unknown;
  export type Static<T> = any;
}

declare module "@earendil-works/pi-tui" {
  export interface AutocompleteItem {
    value: string;
    label: string;
    description?: string;
  }

  export interface Component {
    render(width: number): string[];
    invalidate(): void;
    handleInput?(data: string): void;
  }
  export interface TUI extends Component {
    terminal: { rows: number; columns?: number };
    requestRender(force?: boolean): void;
  }
  export class Text implements Component {
    constructor(text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string);
    render(width: number): string[];
    invalidate(): void;
  }
  export class Box implements Component {
    constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
    addChild(component: Component): void;
    render(width: number): string[];
    invalidate(): void;
  }
  export const Key: Record<string, string>;
  export function matchesKey(data: string, key: string): boolean;
  export function truncateToWidth(text: string, width: number, ellipsis?: string, preserveAnsi?: boolean): string;
  export function wrapTextWithAnsi(text: string, width: number): string[];
}

declare module "@earendil-works/pi-coding-agent" {
  export interface SessionEntry {
    id: string;
    parentId: string | null;
    type: string;
    customType?: string;
    data?: unknown;
    message?: unknown;
  }

  export interface ReadonlySessionManagerContract {
    getEntries(): readonly SessionEntry[];
    getBranch(fromId?: string): readonly SessionEntry[];
    getLeafId(): string | null;
  }

  export interface ThemeContract {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
    bold(text: string): string;
  }

  export interface ExtensionUIContextContract {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    custom<T>(factory: (tui: import("@earendil-works/pi-tui").TUI, theme: ThemeContract, keybindings: unknown, done: (result: T) => void) => import("@earendil-works/pi-tui").Component | Promise<import("@earendil-works/pi-tui").Component>, options?: { overlay?: boolean; overlayOptions?: Record<string, unknown>; onHandle?: (handle: unknown) => void }): Promise<T>;
    readonly theme: ThemeContract;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContextContract;
    mode: "tui" | "rpc" | "json" | "print";
    hasUI: boolean;
    sessionManager: ReadonlySessionManagerContract;
    isIdle(): boolean;
    abort(): void;
    getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
    navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
  }

  export interface ExtensionAPI {
    on(name: string, handler: (...args: any[]) => unknown): void;
    registerCommand(name: string, def: {
      description?: string;
      getArgumentCompletions?(prefix: string): import("@earendil-works/pi-tui").AutocompleteItem[] | null | Promise<import("@earendil-works/pi-tui").AutocompleteItem[] | null>;
      handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
    }): void;
    registerTool(def: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute(
        toolCallId: string,
        params: any,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ExtensionContext,
      ): Promise<unknown>;
    }): void;
    registerEntryRenderer<T = unknown>(customType: string, renderer: (entry: { data?: T }, options: { expanded: boolean }, theme: ThemeContract) => import("@earendil-works/pi-tui").Component): void;
    appendEntry<T = unknown>(customType: string, data?: T): void;
    setLabel(entryId: string, label: string | undefined): void;
    sendUserMessage(content: string | unknown[], options?: { deliverAs?: "steer" | "followUp" }): void;
  }

  export function buildSessionContext(
    entries: readonly SessionEntry[],
    leafId?: string,
    byId?: Map<string, SessionEntry>,
  ): { messages: unknown[] };
}
