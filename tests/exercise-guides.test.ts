import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendExerciseGuides } from '../src/exercise-guides.ts';

const crunch = { name: 'Abdominal Crunch Machine', aliases: [] };
const crunchGuide = 'https://www.acefitness.org/resources/everyone/exercise-library/291/seated-crunch/';

void test('a matching exercise gets a readable guide without another exercise title', () => {
  const note = '---\nexercise_name: Abdominal Crunch Machine\n---\n';
  const expected = `${note}\n## Exercise guides\n\n- [ACE Fitness](<${crunchGuide}>)\n`;
  assert.equal(appendExerciseGuides(note, crunch), expected);
  assert.equal(appendExerciseGuides(expected, crunch), expected);
});

void test('new links join an existing guide section without changing surrounding prose or line endings', () => {
  const note = '---\r\nexercise_name: Custom machine\r\n---\r\n\r\nRemember the seat setting.\r\n\r\n' +
    '## Exercise guides\r\n\r\n- [Video](https://example.org/video)\r\n\r\n## Training notes\r\n\r\nKeep the tempo steady.\r\n';
  const sources = ['https://example.org/video/', 'https://training.example/machine', 'https://training.example/machine/', 'javascript:alert(1)'];
  const exercise = { name: 'Custom machine', aliases: [] };
  const expected = note.replace('- [Video]', '- [training.example](<https://training.example/machine>)\r\n- [Video]');
  assert.equal(appendExerciseGuides(note, exercise, sources), expected);
  assert.equal(appendExerciseGuides(expected, exercise, sources), expected);
});

void test('a source stored in frontmatter is surfaced even when no catalog exercise matches', () => {
  const source = 'https://example.org/guide';
  const note = `---\nsources:\n  - ${source}\n---\n\nMy notes.\n`;
  assert.equal(appendExerciseGuides(note, { name: 'Custom movement', aliases: [] }, [source]),
    `${note}\n## Exercise guides\n\n- [example.org](<${source}>)\n`);
});

void test('guide lookup accepts exact normalized aliases and leaves ambiguous variants alone', () => {
  assert.match(appendExerciseGuides('', { name: 'Legacy exercise', aliases: [' flat   DUMBBELL bench press '] }), /19\/chest-press\//);
  assert.equal(appendExerciseGuides('', { name: 'Legacy exercise', aliases: ['Chest Press Machine', 'Bench press'] }), '');
  assert.equal(appendExerciseGuides('My custom form notes.\n', { name: 'Shoulder Press', aliases: [] }), 'My custom form notes.\n');
});
