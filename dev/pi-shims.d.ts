declare module "@earendil-works/pi-ai" {
  export const Type: any;
  export type Static<T> = any;
}

declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
  export type ExtensionCommandContext = any;
  export type SessionManager = any;
  export type SessionEntry = any;
  export function buildSessionContext(...args: any[]): any;
}
