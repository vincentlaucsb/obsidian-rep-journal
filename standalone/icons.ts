/*! @license lucide-static v0.446.0 (ISC) | https://lucide.dev

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Feather (MIT) | https://feathericons.com
Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const svgNamespace = 'http://www.w3.org/2000/svg';
type IconShape = [tag: 'path' | 'rect' | 'line', attributes: Readonly<Record<string, string | number>>];
type IconName = 'chart-line' | 'plus' | 'calendar' | 'dumbbell' | 'menu' | 'trophy';
const icons: Record<IconName, IconShape[]> = {
  trophy: [
    ['path', { d: 'M8 3h8v6a4 4 0 0 1-8 0V3ZM8 5H4v1a4 4 0 0 0 4 4m8-5h4v1a4 4 0 0 1-4 4M12 13v4m-4 4v-1a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v1ZM6 21h12' }],
  ],
  'chart-line': [['path', { d: 'M3 3v16a2 2 0 0 0 2 2h16' }], ['path', { d: 'm19 9-5 5-4-4-3 3' }]],
  plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
  calendar: [
    ['path', { d: 'M8 2v4' }], ['path', { d: 'M16 2v4' }],
    ['rect', { width: 18, height: 18, x: 3, y: 4, rx: 2 }], ['path', { d: 'M3 10h18' }],
  ],
  dumbbell: [
    ['path', { d: 'M14.4 14.4 9.6 9.6' }],
    ['path', { d: 'M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z' }],
    ['path', { d: 'm21.5 21.5-1.4-1.4' }], ['path', { d: 'M3.9 3.9 2.5 2.5' }],
    ['path', { d: 'M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z' }],
  ],
  menu: [12, 6, 18].map(y => ['line', { x1: 4, x2: 20, y1: y, y2: y }]),
};

export function lucideIcon(document: Document, name: IconName): SVGSVGElement {
  const svg = document.createElementNS(svgNamespace, 'svg');
  for (const [attribute, value] of Object.entries({
    class: `lucide lucide-${name}`,
    viewBox: '0 0 24 24',
    width: '24',
    height: '24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })) svg.setAttribute(attribute, value);
  for (const [tag, attributes] of icons[name]) {
    const shape = document.createElementNS(svgNamespace, tag);
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, String(value));
    svg.append(shape);
  }
  return svg;
}
