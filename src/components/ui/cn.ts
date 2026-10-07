/**
 * Minimal class-name joiner. No dependency, no `any`.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
