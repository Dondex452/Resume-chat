/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The app's single AI-error vocabulary (M8, PRD §5.2 graceful degradation).
 *
 * Every surface that reports a provider failure maps the same machine codes
 * through this one function, so the wording can never drift between them:
 * the studio chat pane (`ChatArea`) and the `#/templates` generator both
 * import it. Adding a surface means reusing this function — never a second
 * code→copy table.
 */

import type { AiError } from '../types';

/**
 * Turns a machine-readable AI error code into plain-language copy.
 * Falls back to the raw server message for unknown codes.
 */
export function describeAiError(error: AiError): string {
  switch (error.code) {
    case 'AI_NOT_CONFIGURED':
      return 'No AI provider is configured yet. Add a provider and API key, or point the app at a local model.';
    case 'AI_AUTH':
      return 'The AI provider rejected the API key. Check the key in AI settings.';
    case 'AI_UNREACHABLE':
      return 'The AI provider could not be reached. Check the base URL and your network connection.';
    case 'AI_TIMEOUT':
      return 'The AI provider timed out before responding. It may be slow or unreachable.';
    case 'AI_RATE_LIMIT':
      return 'The AI provider is rate limiting requests. Wait a moment and try again.';
    default:
      return error.message || 'Something went wrong while contacting the AI provider.';
  }
}
