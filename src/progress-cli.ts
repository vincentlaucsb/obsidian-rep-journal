import { progressExercises } from './analytics.ts';
import { matchesExerciseName } from './catalog.ts';
import { progressHistory } from './journal-workflow.ts';
import { describeSet, isDate, type LedgerData, type WeightUnit } from './model.ts';

export async function runProgressCli(
  params: { exercise?: string; since?: string; format?: string },
  readJournal: () => Promise<{ data: LedgerData; unit: WeightUnit }>,
): Promise<string> {
  const query = params.exercise?.trim();
  if (!query) throw new Error('Specify an exercise name, alias, or ID with exercise=<name or ID>.');
  const { since, format = 'text' } = params;
  if (since !== undefined && !isDate(since)) throw new Error('Use since=YYYY-MM-DD with a valid date.');
  if (format !== 'json' && format !== 'text') throw new Error('Use format=json or format=text.');

  const { data, unit: journalUnit } = await readJournal();
  const exercises = progressExercises(data);
  const byId = exercises.find(({ id }) => id === query);
  const matches = byId ? [byId] : exercises.filter((exercise) => matchesExerciseName(exercise, query, true));
  if (!matches.length) throw new Error(`No exercise matches "${query}".`);
  if (matches.length > 1) {
    const choices = matches.map(({ name, id }) => `${name} (${id})`).join(', ');
    throw new Error(`Multiple exercises match "${query}". Use an exercise ID: ${choices}.`);
  }

  const selected = matches[0];
  const { id, name } = selected;
  const { unit, sessions } = progressHistory(data, selected, journalUnit);
  const result = { exercise: { id, name }, unit, sessions: sessions.filter(({ date }) => !since || date >= since), issues: data.issues };
  if (format === 'json') return JSON.stringify(result, null, 2);

  const lines = [`${name} (${id})`];
  if (!result.sessions.length) lines.push(since ? `No recorded sessions since ${since}.` : 'No recorded sessions.');
  for (const session of result.sessions) {
    const { date, number, estimatedMax, sets, personalRecordIndices } = session;
    lines.push('', number === undefined ? date : `${date} (session ${number})`);
    if (estimatedMax) {
      const { value, setIndex } = estimatedMax;
      lines.push(`Estimated 1RM: ${value.toFixed(1)} ${unit} from set ${setIndex + 1}`);
    }
    for (const [index, set] of sets.entries()) {
      const flags = set.warmup ? ' (warm-up)' : personalRecordIndices.includes(index) ? ` (${set.reps}-rep PR)` : '';
      lines.push(`  ${index + 1}. ${describeSet(set)}${flags}`);
    }
  }
  if (data.issues.length) lines.push('', 'Journal issues:', ...data.issues);
  return lines.join('\n');
}
