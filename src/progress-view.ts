import { exerciseHistory, strengthTrend, type StrengthPoint } from './analytics.ts';
import { describeSet, type ExerciseChoice, type LedgerData, type WeightUnit } from './model.ts';
import { actionButton } from './ui-controls.ts';

interface ChartPoint {
  x: number;
  y: number;
  set: StrengthPoint;
}

function drawChart(parent: HTMLElement, points: StrengthPoint[], unit: WeightUnit): () => void {
  const drawing = parent.createEl('canvas', {
    cls: 'rep-journal-chart', attr: { role: 'img', 'aria-label': `Estimated one-rep maximum over time in ${unit}` },
  });
  const detail = parent.createEl('p', { cls: 'rep-journal-muted rep-journal-chart-detail' });
  const win = drawing.ownerDocument.defaultView;
  const context = drawing.getContext('2d');
  let locations: ChartPoint[] = [];
  let selected = points[points.length - 1];

  function show(point: StrengthPoint): void {
    detail.setText(`${point.date} · ${point.value.toFixed(1)} ${unit} · ${describeSet(point.set)}`);
  }

  function paint(): void {
    if (!win || !context) return;
    const width = drawing.clientWidth;
    const height = drawing.clientHeight;
    if (width < 100 || height < 100) return;
    const scale = win.devicePixelRatio || 1;
    drawing.width = Math.round(width * scale);
    drawing.height = Math.round(height * scale);
    context.scale(scale, scale);
    const theme = win.getComputedStyle(drawing);
    const text = theme.getPropertyValue('--text-muted').trim() || '#666';
    const grid = theme.getPropertyValue('--background-modifier-border').trim() || '#888';
    const accent = theme.getPropertyValue('--interactive-accent').trim() || '#6750a4';
    const plot = { left: 55, right: width - 14, top: 14, bottom: height - 30 };

    const values = points.map((point) => point.value);
    const low = values.reduce((min, value) => Math.min(min, value), values[0]);
    const high = values.reduce((max, value) => Math.max(max, value), values[0]);
    const pad = Math.max((high - low) * 0.12, high * 0.015, 1);
    const minimum = Math.max(0, low - pad);
    const maximum = high + pad;
    const first = Date.parse(points[0].date);
    const last = Date.parse(points[points.length - 1].date);

    context.font = `12px ${theme.fontFamily}`;
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    context.fillStyle = text;
    context.strokeStyle = grid;
    context.lineWidth = 1;
    for (let line = 0; line <= 4; line++) {
      const part = line / 4;
      const y = plot.top + (plot.bottom - plot.top) * part;
      const value = maximum - (maximum - minimum) * part;
      context.fillText(`${value.toFixed(0)}`, plot.left - 8, y);
      context.beginPath();
      context.moveTo(plot.left, y);
      context.lineTo(plot.right, y);
      context.stroke();
    }

    locations = points.map((set) => ({
      set,
      x: first === last ? (plot.left + plot.right) / 2 : plot.left + (plot.right - plot.left) * (Date.parse(set.date) - first) / (last - first),
      y: plot.bottom - (plot.bottom - plot.top) * (set.value - minimum) / (maximum - minimum),
    }));
    context.textAlign = first === last ? 'center' : 'left';
    context.fillText(points[0].date, first === last ? locations[0].x : plot.left, height - 12);
    if (first !== last) {
      context.textAlign = 'right';
      context.fillText(points[points.length - 1].date, plot.right, height - 12);
    }

    context.strokeStyle = accent;
    context.fillStyle = accent;
    context.lineWidth = 2;
    context.beginPath();
    for (const [index, point] of locations.entries()) {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }
    context.stroke();
    for (const point of locations) {
      context.beginPath();
      context.arc(point.x, point.y, point.set === selected ? 5 : 3, 0, Math.PI * 2);
      context.fill();
    }
  }

  function closest(event: MouseEvent): ChartPoint | undefined {
    const box = drawing.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    let match: ChartPoint | undefined;
    let threshold = 26;
    for (const point of locations) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < threshold) {
        match = point;
        threshold = distance;
      }
    }
    return match;
  }

  drawing.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const match = closest(event);
    show(match?.set ?? selected);
  });
  drawing.addEventListener('pointerleave', () => show(selected));
  drawing.addEventListener('click', (event) => {
    const match = closest(event);
    if (match) {
      selected = match.set;
      show(selected);
      paint();
    }
  });
  show(selected);
  paint();
  const observer = win?.ResizeObserver ? new win.ResizeObserver(paint) : undefined;
  observer?.observe(drawing);
  return () => observer?.disconnect();
}

interface ProgressOptions {
  data: LedgerData;
  exercise?: ExerciseChoice;
  unit: WeightUnit;
  chooseExercise: () => void;
  editExercise?: () => void;
}

export function renderProgressView(parent: HTMLElement, options: ProgressOptions): (() => void) | undefined {
  const { data, exercise, unit } = options;
  const toolbar = parent.createDiv({ cls: 'rep-journal-actions' });
  actionButton(toolbar, exercise?.name ?? 'Choose exercise', options.chooseExercise, !exercise);
  if (!exercise) {
    parent.createEl('p', { text: 'Choose an exercise to review its progress.', cls: 'rep-journal-muted' });
    return;
  }
  if (options.editExercise) actionButton(toolbar, 'Edit exercise', options.editExercise);
  const history = exerciseHistory(data.workouts.map(({ workout }) => workout), exercise.id);
  const points = strengthTrend(history, unit);
  let clean: (() => void) | undefined;
  const estimatesEnabled = exercise.measurements.includes('weight') && exercise.measurements.includes('reps') &&
    exercise.loadMode !== 'assistance' && exercise.loadMode !== 'added';
  if (points.length || estimatesEnabled) {
    const graph = parent.createDiv({ cls: 'rep-journal-panel' });
    graph.createEl('h3', { text: 'Estimated 1RM' });
    if (points.length) clean = drawChart(graph, points, unit);
    else graph.createEl('p', { text: 'Log a weighted set of 1–10 reps to see an estimate.', cls: 'rep-journal-muted' });
  }

  const sessions = parent.createDiv({ cls: 'rep-journal-panel' });
  sessions.createEl('h3', { text: 'Exercise history' });
  if (!history.length) sessions.createEl('p', { text: 'No sets recorded for this exercise.', cls: 'rep-journal-muted' });
  const estimates = new Map(points.map((point) => [point.sessionId, point.value]));
  for (const { workout, sets } of history) {
    const details = sessions.createEl('details', { cls: 'rep-journal-history' });
    const estimate = estimates.get(workout.id);
    details.createEl('summary', { text: `${workout.date} · ${sets.length} ${sets.length === 1 ? 'set' : 'sets'}${
      estimate === undefined ? '' : ` · ${estimate.toFixed(1)} ${unit} estimated`
    }` });
    const list = details.createEl('ol');
    for (const set of sets) list.createEl('li', { text: describeSet(set) });
  }
  return clean;
}
