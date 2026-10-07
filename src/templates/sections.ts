/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M10 — the personal-details and signature section builders (PRD §8, §5.4).
 *
 * Both blocks are DATA laid on top of any design, exactly like every other
 * section. Built-ins carry them disabled (so their current output is unchanged);
 * a country preset turns them on, and `applyCountryPreset` can synthesize them
 * for a template that does not ship with them (a custom/generated design).
 *
 * The class bundles are neutral and light-surface oriented because both blocks
 * are placed in the `main` column. The heading deliberately has no default
 * override, so each design's own `tokens.headingClass` styles it.
 */

import type {
  PersonalProps,
  SectionSpec,
  SignatureProps,
} from './schema';

/** Last of the main-column sections in the ten built-ins. */
export const PERSONAL_SECTION_ORDER = 8;
export const SIGNATURE_SECTION_ORDER = 9;

export const PERSONAL_SECTION_LABEL = 'Personal Details';
/** Empty: the ruled line carries its own caption. A preset may override it. */
export const SIGNATURE_SECTION_LABEL = '';

const PERSONAL_DEFAULTS: PersonalProps = {
  containerClass: '',
  listClass: 'space-y-1',
  rowClass: 'flex gap-2 text-xs leading-relaxed',
  labelClass: 'font-semibold text-gray-700',
  valueClass: 'text-gray-600',
  separator: ': ',
};

const SIGNATURE_DEFAULTS: SignatureProps = {
  containerClass: '',
  rowClass: 'flex gap-6 text-xs text-gray-600 mt-4',
  placeClass: '',
  dateClass: '',
  lineClass:
    'mt-10 w-56 border-t border-gray-400 pt-1 text-[10px] uppercase tracking-wider text-gray-500',
  lineLabel: 'Signature',
};

/**
 * A personal-details block, disabled by default. `props` replaces the neutral
 * defaults wholesale so a design can restyle the block without inheriting any
 * of them.
 */
export function createPersonalSection(
  order: number = PERSONAL_SECTION_ORDER,
  props?: PersonalProps
): SectionSpec {
  return {
    key: 'personal',
    label: PERSONAL_SECTION_LABEL,
    enabled: false,
    order,
    column: 'main',
    variant: 'list',
    props: props ?? { ...PERSONAL_DEFAULTS },
  };
}

/** A signature block (place / date / ruled line), disabled by default. */
export function createSignatureSection(
  order: number = SIGNATURE_SECTION_ORDER,
  props?: SignatureProps
): SectionSpec {
  return {
    key: 'signature',
    label: SIGNATURE_SECTION_LABEL,
    enabled: false,
    order,
    column: 'main',
    variant: 'list',
    props: props ?? { ...SIGNATURE_DEFAULTS },
  };
}
