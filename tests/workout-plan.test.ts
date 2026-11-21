import assert from 'node:assert/strict';
import { test } from 'node:test';
import { starterExercises } from '../src/catalog.ts';
import { type WorkoutSet } from '../src/model.ts';
import { advanceWorkoutPlan, parseWorkoutPlan } from '../src/workout-plan.ts';

const catalog = starterExercises([]);
const bench = catalog.find((exercise) => exercise.name === 'Bench Press');
const facePull = catalog.find((exercise) => exercise.name === 'Face Pull');
const rowing = catalog.find((exercise) => exercise.name === 'Rowing');
assert.ok(bench && facePull && rowing);

void test('reads section and exercise notes in order and resolves normalized aliases', () => {
  const markdown = [
    '# Upper body', '', 'Intro with a [link](https://example.com).', '',
    '## Warm-Up', '', 'Start easy.', '',
    '## Phase 1: Main sets ##', '', 'mode: SUPERSET ', '', '- Take your time.', '',
    '### bARbell   bench press ###', '', '**3 sets** of 8–10.', '#### A cue', 'Feet on the floor.', '',
    '### Face Pulls', '', 'Rest 90 seconds here.', '',
  ].join('\r\n');

  assert.deepEqual(parseWorkoutPlan(markdown, catalog), { plan: {
    title: 'Upper body', notes: 'Intro with a [link](https://example.com).', sections: [
      { name: 'Warm-Up', superset: false, notes: 'Start easy.', exercises: [] },
      { name: 'Phase 1: Main sets', superset: true, notes: '- Take your time.', exercises: [
        { name: 'bARbell   bench press', exerciseId: bench.id, notes: '**3 sets** of 8–10.\n#### A cue\nFeet on the floor.' },
        { name: 'Face Pulls', exerciseId: facePull.id, notes: 'Rest 90 seconds here.' },
      ] },
    ],
  } });
});

void test('ignores headings in frontmatter, fences and comments and keeps their note content', () => {
  const fencedNotes = [
    '````markdown', '## Example section', '```', '### Example exercise', '````',
    '', '~~~', '## Another example', '~~~', '', '    ### Indented code',
    '', '<!--', '## Private section', '-->', '', '%%', '### A private exercise', '%%',
  ];
  const markdown = [
    '\uFEFF---', 'description: |', '  ## Properties are not a plan', '---',
    '## First', '### Bench Press', ...fencedNotes, '### Face Pull',
  ].join('\n');
  const { plan } = parseWorkoutPlan(markdown, catalog);
  assert.ok(plan);
  assert.equal(plan.sections.length, 1);
  assert.equal(plan.sections[0].exercises.length, 2);
  assert.equal(plan.sections[0].exercises[0].notes, fencedNotes.join('\n'));
});

void test('reports actionable line numbers for malformed and unmatched headings', () => {
  const duplicate = { ...facePull, name: 'Cable Face Pull', aliases: ['Face Pulls'] };
  const markdown = '\uFEFF---\nvalid: true\n---\n### Bench Press\n##\n## Phase\nMode: circuit\n### Bench Pres\n### Face Pulls\n###\n';
  const { issues, plan } = parseWorkoutPlan(markdown, [...catalog, duplicate]);
  assert.equal(plan, undefined);
  assert.deepEqual(issues?.map((issue) => issue.line), [4, 5, 7, 8, 9, 10]);
  assert.match(issues?.[3].message ?? '', /Possible matches: Bench Press/);
  assert.match(issues?.[4].message ?? '', /Face Pull.*Cable Face Pull.*unique name or alias/);
  assert.match(parseWorkoutPlan('---\nnot closed', catalog).issues?.[0].message ?? '', /Close the note properties/);
});

void test('requires a logged exercise somewhere and recognizes the mode only below a section heading', () => {
  assert.match(parseWorkoutPlan('## Warm-Up\nStart easy.', catalog).issues?.[0].message ?? '', /at least one/);
  assert.match(parseWorkoutPlan('## Main\nMode: superset\n### Bench Press', catalog).issues?.[0].message ?? '', /at least two/);
  const { plan } = parseWorkoutPlan('## Main\nUse this as a cue\nMode: superset\n### Bench Press', catalog);
  assert.equal(plan?.sections[0].superset, false);
  assert.equal(plan?.sections[0].notes, 'Use this as a cue\nMode: superset');
  assert.match(parseWorkoutPlan('## Main\n### Bench Press', [{ ...bench, archived: true }]).issues?.[0].message ?? '', /archived/);
});

void test('rotates by heading position and only for an added set on the selected exercise', () => {
  const { plan } = parseWorkoutPlan([
    '## Superset', 'Mode: superset', '### Bench Press', '### Face Pull', '### Barbell Bench Press',
    '## Regular', '### Bench Press', '### Face Pull',
  ].join('\n'), catalog);
  assert.ok(plan);
  const first = { sectionIndex: 0, exerciseIndex: 0 };
  const second = { sectionIndex: 0, exerciseIndex: 1 };
  const third = { sectionIndex: 0, exerciseIndex: 2 };
  const regular = { sectionIndex: 1, exerciseIndex: 0 };
  const set: WorkoutSet = { id: 'a', exerciseId: bench.id, exerciseName: bench.name, reps: 5, warmup: false };
  assert.deepEqual(advanceWorkoutPlan(plan, first, { kind: 'add', set }), second);
  assert.deepEqual(advanceWorkoutPlan(plan, second, { kind: 'add', set: { ...set, exerciseId: facePull.id } }), third);
  assert.deepEqual(advanceWorkoutPlan(plan, third, { kind: 'add', set }), first);
  assert.equal(advanceWorkoutPlan(plan, first, { kind: 'add', set: { ...set, exerciseId: rowing.id } }), first);
  assert.equal(advanceWorkoutPlan(plan, second, { kind: 'add', set }), second);
  assert.equal(advanceWorkoutPlan(plan, regular, { kind: 'add', set }), regular);
  assert.equal(advanceWorkoutPlan(plan, first, { kind: 'edit', original: set, set }), first);
  assert.equal(advanceWorkoutPlan(plan, first, { kind: 'remove', original: set }), first);
  assert.equal(advanceWorkoutPlan(plan, first, { kind: 'notes', original: '', value: 'Rested' }), first);
});
