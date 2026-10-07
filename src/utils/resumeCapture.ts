/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * html2canvas 1.4 predates CSS Color 4 and throws
 * `Attempting to parse an unsupported color function "oklch"` on any computed
 * value it cannot read. Tailwind 4 emits `oklch()` for its whole palette and
 * `color-mix()` for opacity modifiers, so every PDF export failed at the first
 * element parsed.
 *
 * This rewrites those values, in html2canvas' *cloned* tree only, to exact
 * sRGB `rgba()` equivalents sampled through a 1×1 canvas — the browser does the
 * colour conversion, so the exported pixels match the preview exactly. No new
 * dependency, and the live DOM is never touched.
 */

const MODERN_COLOR_FUNCTION = /(?:color-mix|color|oklch|oklab|lch|lab|hwb)\s*\(/gi;
const MAYBE_MODERN_COLOR = /(?:color-mix|color|oklch|oklab|lch|lab|hwb)\(/i;

let sampler: CanvasRenderingContext2D | null | undefined;

function getSampler(): CanvasRenderingContext2D | null {
  if (sampler === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    sampler = canvas.getContext('2d', { willReadFrequently: true });
  }
  return sampler;
}

/** Resolves any CSS colour to `rgba()` by asking the browser to paint one pixel. */
function toRgba(color: string): string | null {
  const ctx = getSampler();
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${data[0]}, ${data[1]}, ${data[2]}, ${(data[3] / 255).toFixed(4)})`;
  } catch {
    return null;
  }
}

/** Replaces every modern colour function in a value, including nested ones. */
function rewriteColorFunctions(value: string): string {
  MODERN_COLOR_FUNCTION.lastIndex = 0;
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = MODERN_COLOR_FUNCTION.exec(value)) !== null) {
    const start = match.index;
    const openParen = start + match[0].length - 1;

    let depth = 0;
    let end = -1;
    for (let i = openParen; i < value.length; i += 1) {
      const char = value[i];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) break;

    const rgba = toRgba(value.slice(start, end));
    if (rgba) {
      out += value.slice(cursor, start) + rgba;
      cursor = end;
      MODERN_COLOR_FUNCTION.lastIndex = end;
    }
  }

  return cursor === 0 ? value : out + value.slice(cursor);
}

/**
 * Walks the cloned subtree html2canvas is about to rasterise and replaces every
 * computed value that still uses a CSS Color 4 function.
 */
export function resolveModernColorsForCapture(root: HTMLElement): void {
  const view = root.ownerDocument.defaultView;
  if (!view) return;

  const walk = (element: Element) => {
    const computed = view.getComputedStyle(element);
    const count = computed.length;

    for (let i = 0; i < count; i += 1) {
      const property = computed.item(i);
      if (!property || property.startsWith('--')) continue;

      const value = computed.getPropertyValue(property);
      if (!value || !MAYBE_MODERN_COLOR.test(value)) continue;

      const rewritten = rewriteColorFunctions(value);
      if (rewritten !== value) {
        (element as HTMLElement).style.setProperty(property, rewritten);
      }
    }

    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
      walk(child);
    }
  };

  walk(root);
}
