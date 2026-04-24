/*
 * Type declarations for the pure helpers exported by chrome.js via its
 * CommonJS export guard. The browser IIFE body is invisible to callers — only
 * Bun unit tests import these helpers.
 */

export const SYSTEMS: readonly ["operator-console"];
export const THEMES: readonly ["dark", "light"];
export const GNAV: Readonly<Record<string, string>>;
export const GNAV_LABELS: Readonly<Record<string, string>>;

export function isTypingTarget(el: unknown): boolean;
export function shouldIgnoreKey(ev: { key?: string; target?: unknown } | null | undefined): boolean;
export function nextSystem(current: string): string;
export function nextTheme(current: string): string;
export function resolveGNav(key: string): string | undefined;

export function parseBreadcrumb(value: string | null | undefined): string[];

export function isMacPlatform(
  nav: { platform?: string; userAgent?: string } | null | undefined,
): boolean;

export type PaletteActionType = "nav" | "appearance" | "help";
export interface PaletteAction {
  id: string;
  group: "Navigate" | "Appearance" | "Help";
  label: string;
  hint?: readonly string[];
  type: PaletteActionType;
  // `payload.path` for nav actions; `payload.action` for appearance/help.
  payload: { path?: string; action?: string };
}

export function paletteActions(gnav: Readonly<Record<string, string>>): PaletteAction[];
export function filterPaletteActions(actions: PaletteAction[], query: string): PaletteAction[];
