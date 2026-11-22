import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strengthChartAxis, strengthChartRange } from '../standalone/strength-chart.ts';

void test('strength chart ranges follow calendar arithmetic and retain every session on an included date', () => {
  const points = [
    { date: '2024-02-28', session: 'before' },
    { date: '2024-02-29', session: 'first' },
    { date: '2024-02-29', session: 'second' },
    { date: '2024-03-31', session: 'today' },
    { date: '2024-04-01', session: 'later' },
  ];
  const today = '2024-03-31';
  const month = strengthChartRange(points, today, '1M');
  assert.equal(month.start, Date.parse('2024-02-29'));
  assert.equal(month.end, Date.parse(today));
  assert.deepEqual(month.points.map(point => point.session), ['first', 'second', 'today']);
  assert.equal(strengthChartRange(points, today, '1W').start, Date.parse('2024-03-24'));
  assert.equal(strengthChartRange(points, today, '3M').start, Date.parse('2023-12-31'));
  assert.equal(strengthChartRange(points, today, '6M').start, Date.parse('2023-09-30'));
  assert.equal(strengthChartRange(points, '2024-02-29', '1Y').start, Date.parse('2023-02-28'));
  assert.deepEqual(strengthChartRange(points, today, 'Max'), {
    points, start: Date.parse('2024-02-28'), end: Date.parse('2024-04-01'),
  });
  assert.deepEqual(strengthChartRange(points, '2022-03-31', '1Y').points, []);
});

void test('strength chart ticks are unique calendar dates positioned by elapsed days', () => {
  const start = Date.parse('2023-12-29');
  const end = Date.parse('2024-01-05');
  const format = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const { xDomain, xTickLabels } = strengthChartAxis(start, end, 390);
  assert.deepEqual(xDomain, [0, 7]);
  assert.deepEqual(xTickLabels.map(tick => tick.value), [0, 2, 5, 7]);
  assert.deepEqual(xTickLabels.map(tick => tick.label), ['2023-12-29', '2023-12-31', '2024-01-03', '2024-01-05']
    .map(date => format.format(Date.parse(date))));
  const adjacent = strengthChartAxis(start, Date.parse('2023-12-30'), 900);
  assert.deepEqual(adjacent.xTickLabels.map(tick => tick.value), [0, 1]);
  const singleton = strengthChartAxis(start, start, 390);
  assert.deepEqual(singleton.xDomain, [0, 0]);
  assert.deepEqual(singleton.xTickLabels.map(tick => tick.value), [0]);
});
