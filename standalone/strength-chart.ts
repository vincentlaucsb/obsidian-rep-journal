import type { LineChartOptions } from 'svgplot-wasm';
import type { exerciseProgress } from '../src/journal-workflow.ts';
import type { WeightUnit } from '../src/model.ts';
import type { CreateJournalElement } from './app.js';

type StrengthChartRange = '1W' | '1M' | '3M' | '6M' | '1Y' | 'Max';
type TrendPoint = ReturnType<typeof exerciseProgress>['trend'][number];

const dayMs = 86400000;
const ranges: ReadonlyArray<readonly [StrengthChartRange, string]> = [
  ['1W', '1 week'], ['1M', '1 month'], ['3M', '3 months'], ['6M', '6 months'], ['1Y', '1 year'], ['Max', 'All time'],
];
const rangeMonths = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function strengthChartRange<T extends { date: string }>(points: readonly T[], today: string, range: StrengthChartRange) {
  const end = Date.parse(today);
  if (range === 'Max') {
    return {
      points, start: points.length ? Date.parse(points[0].date) : end,
      end: points.length ? Date.parse(points[points.length - 1].date) : end,
    };
  }
  let start = end - 7 * dayMs;
  if (range !== '1W') {
    const date = new Date(end);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - rangeMonths[range]);
    const last = new Date(date);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    start = date.setUTCDate(Math.min(day, last.getUTCDate()));
  }
  return {
    start, end,
    points: points.filter(({ date }) => {
      const time = Date.parse(date);
      return start <= time && time <= end;
    }),
  };
}

export function strengthChartAxis(start: number, end: number, width: number): {
  xDomain: [number, number]; xTickLabels: NonNullable<LineChartOptions['xTickLabels']>;
} {
  const days = (end - start) / dayMs;
  const formatter = new Date(start).getUTCFullYear() === new Date(end).getUTCFullYear() ? monthDay : fullDate;
  const count = Math.min(days + 1, 5, Math.max(2, Math.floor((width - 100) / 86) + 1));
  return {
    xDomain: [0, days],
    xTickLabels: Array.from({ length: count }, (_, index) => {
      const value = count === 1 ? 0 : Math.round(index * days / (count - 1));
      return { value, label: formatter.format(start + value * dayMs) };
    }),
  };
}

export function mountStrengthChart(
  section: HTMLElement, points: readonly TrendPoint[], unit: WeightUnit, today: string,
  drawChart: (host: HTMLElement, options: LineChartOptions) => Promise<SVGSVGElement>,
  createElement: CreateJournalElement,
): () => void {
  const document = section.ownerDocument;
  const create = <Tag extends keyof HTMLElementTagNameMap>(name: Tag, text?: string): HTMLElementTagNameMap[Tag] => {
    const element = createElement(name);
    if (text) element.textContent = text;
    return element;
  };
  const plot = create('div');
  plot.className = 'strength-chart-plot';
  const rangePicker = create('div');
  rangePicker.className = 'strength-chart-ranges';
  rangePicker.setAttribute('role', 'group');
  rangePicker.setAttribute('aria-label', 'Chart date range');
  const rangeButtons = new Map(ranges.map(([range, label]) => {
    const button = create('button', range);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => selectRange(range));
    rangePicker.append(button);
    return [range, button];
  }));
  const status = create('p');
  status.className = 'secondary';
  status.setAttribute('role', 'status');
  const controls = create('div');
  controls.className = 'strength-chart-controls';
  const previous = create('button', 'Previous');
  previous.type = 'button';
  previous.setAttribute('aria-label', 'Previous estimated 1RM');
  const next = create('button', 'Next');
  next.type = 'button';
  next.setAttribute('aria-label', 'Next estimated 1RM');
  const detail = create('p');
  detail.className = 'strength-chart-detail';
  detail.setAttribute('aria-live', 'polite');
  controls.append(previous, next, detail);
  section.append(rangePicker, plot, status, controls);

  let range: StrengthChartRange | undefined;
  let visible: readonly TrendPoint[] = [];
  let start = 0;
  let end = 0;
  let selected = -1;
  let markers: Element[] = [];
  let width = 0;
  let pending = 0;
  let mounted = true;

  function select(index: number) {
    if (index < 0 || index >= visible.length) return;
    markers[selected]?.classList.remove('is-selected');
    selected = index;
    markers[selected]?.classList.add('is-selected');
    const point = visible[selected];
    const session = point.number ? ` · Session ${point.number}` : '';
    detail.textContent = `${point.date}${session} · ${point.value.toFixed(1)} ${unit} · ${point.set}`;
    previous.disabled = selected === 0;
    next.disabled = selected === visible.length - 1;
  }

  function selectRange(nextRange: StrengthChartRange) {
    if (range === nextRange) return;
    const sessionId = visible[selected]?.sessionId;
    range = nextRange;
    const period = strengthChartRange(points, today, range);
    visible = period.points;
    start = period.start;
    end = period.end;
    for (const [name, button] of rangeButtons) button.setAttribute('aria-pressed', String(name === range));
    width = 0;
    ++pending;
    markers = [];
    plot.replaceChildren();
    controls.hidden = !visible.length;
    previous.hidden = next.hidden = visible.length < 2;
    status.hidden = false;
    status.textContent = visible.length ? 'Loading chart…' : 'No estimated 1RM in this range.';
    if (!visible.length) {
      selected = -1;
      detail.textContent = '';
      return;
    }
    const index = visible.findIndex(point => point.sessionId === sessionId);
    select(index < 0 ? visible.length - 1 : index);
    void render();
  }

  previous.addEventListener('click', () => select(selected - 1));
  next.addEventListener('click', () => select(selected + 1));
  plot.addEventListener('click', (event) => {
    const index = markers.findIndex(marker => marker === event.target);
    if (index >= 0) select(index);
  });
  async function render() {
    const nextWidth = Math.round(section.getBoundingClientRect().width);
    if (!mounted || !section.isConnected || !visible.length || !nextWidth || width === nextWidth) return;
    width = nextWidth;
    const version = ++pending;
    const staging = create('div');
    try {
      const chartWidth = Math.max(260, width);
      const svg = await drawChart(staging, {
        data: visible.map(({ date, value }) => [(Date.parse(date) - start) / dayMs, value]),
        width: chartWidth, height: 240, yLabel: unit, ...strengthChartAxis(start, end, chartWidth),
      });
      if (!mounted || version !== pending || !section.isConnected) return;
      // Replace svgplot's embedded stylesheet while the SVG is detached, before the host's CSP applies.
      svg.querySelectorAll('style').forEach(style => style.remove());
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `Estimated 1RM in ${unit} over time`);
      markers = Array.from(svg.querySelectorAll('.line-marker'));
      markers[selected]?.classList.add('is-selected');
      plot.replaceChildren(svg);
      status.hidden = true;
    } catch {
      if (!mounted || version !== pending || !section.isConnected) return;
      status.hidden = false;
      status.textContent = 'Chart unavailable. Exercise history is available below.';
    }
  }

  const ResizeObserver = document.defaultView?.ResizeObserver;
  const observer = ResizeObserver && new ResizeObserver(() => { void render(); });
  observer?.observe(section);
  selectRange('1Y');
  return () => {
    mounted = false;
    observer?.disconnect();
  };
}
