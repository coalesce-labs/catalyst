/*
 * Type declarations for the pure helpers exported by chrome.js via its
 * CommonJS export guard. The browser IIFE body is invisible to callers — only
 * Bun unit tests import these helpers.
 */

export const SYSTEMS: readonly ["operator-console", "precision-instrument"];
export const THEMES: readonly ["dark", "light"];
export const GNAV: Readonly<Record<string, string>>;

export function isTypingTarget(el: unknown): boolean;
export function shouldIgnoreKey(ev: { key?: string; target?: unknown } | null | undefined): boolean;
export function nextSystem(current: string): string;
export function nextTheme(current: string): string;
export function resolveGNav(key: string): string | undefined;
