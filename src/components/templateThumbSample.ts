/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * UI FIXTURE DATA — not user data.
 *
 * A deliberately short, obviously fictional resume used only to draw the
 * template thumbnails (the picker gallery and the studio empty state). It is
 * never written to the database, never sent to a provider and never exported —
 * it exists so every template renders something recognisable instead of a blank
 * sheet. Keep it short so the miniature stays legible at thumbnail scale.
 */

import { ResumeJSON } from '../types';

export const TEMPLATE_THUMB_SAMPLE: ResumeJSON = {
  basics: {
    fullName: 'Alex Sample',
    email: 'alex.sample@example.com',
    phone: '(555) 010-0100',
    location: 'Portland, OR',
    summary:
      'Product designer with six years turning research into shipped interfaces, focused on clear systems and measurable outcomes.',
    links: [{ label: 'alexsample.example', url: 'https://example.com/alex-sample' }]
  },
  work: [
    {
      company: 'Northwind Labs',
      role: 'Senior Product Designer',
      start: '2021',
      end: 'Present',
      highlights: [
        'Led the onboarding redesign that lifted activation 18%.',
        'Built the design system now used by four product squads.'
      ]
    },
    {
      company: 'Blue Harbour Co.',
      role: 'Product Designer',
      start: '2018',
      end: '2021',
      highlights: [
        'Shipped a mobile checkout used by 200,000 customers.',
        'Ran the first usability programme with monthly sessions.'
      ]
    }
  ],
  education: [
    {
      school: 'State University',
      degree: 'B.A.',
      field: 'Design',
      start: '2014',
      end: '2018'
    }
  ],
  skills: [
    { category: 'Design', items: ['Figma', 'Prototyping', 'Design systems'] },
    { category: 'Research', items: ['Interviews', 'Usability testing'] }
  ],
  certifications: [{ name: 'Accessibility Fundamentals', issuer: 'W3C', date: '2022' }],
  languages: [{ name: 'English', proficiency: 'Native' }]
};
