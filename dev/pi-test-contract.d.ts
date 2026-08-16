declare module "@earendil-works/pi-ai" {
  export const Type: {
    Object(value: unknown): unknown;
    Union(value: unknown[]): unknown;
    Literal(value: string): unknown;
    Optional(value: unknown): unknown;
    String(): unknown;
    Number(): unknown;
  };
  export type Static<T> = any;
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

  export interface ExtensionUIContextContract {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContextContract;
    sessionManager: ReadonlySessionManagerContract;
    isIdle(): boolean;
    abort(): void;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
    navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
  }

  export interface ExtensionAPI {
    on(name: string, handler: (...args: any[]) => unknown): void;
    registerCommand(name: string, def: {
      description?: string;
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
    appendEntry<T = unknown>(customType: string, data?: T): void;
    sendUserMessage(content: string | unknown[], options?: { deliverAs?: "steer" | "followUp" }): void;
  }

  export function buildSessionContext(
    entries: readonly SessionEntry[],
    leafId?: string,
    byId?: Map<string, SessionEntry>,
  ): { messages: unknown[] };
}
