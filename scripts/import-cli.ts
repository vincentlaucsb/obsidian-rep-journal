import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { planGarminElevation, writeGarminElevation } from './garmin-elevation-backfill.ts';
import { lockImportVault, readImportVault, resolveImportVaultRoot, writeImportVault } from './import-vault.ts';
import { errorMessage, type ExerciseChoice, type LedgerData } from '../src/model.ts';
import { importExerciseCatalog, planWorkoutImport, type ImportIssue, type WorkoutImportPlan } from '../src/workout-import.ts';

type ImportMode = 'plan' | 'apply' | 'catalog';

const usage = 'npm run --silent import -- --vault PATH --input PATH [--backfill-garmin-elevation] [--apply], or npm run --silent import -- --vault PATH --catalog';

function respond(mode: ImportMode, exitCode: number, issues: ImportIssue[], details: Record<string, unknown> = {}): void {
  const written = mode === 'apply' ? { written: { exercises: [], workouts: [] } } : {};
  const output = { ok: exitCode === 0, mode, issues, ...written, ...details };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = exitCode;
}

function parseCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      vault: { type: 'string' },
      input: { type: 'string' },
      catalog: { type: 'boolean' },
      apply: { type: 'boolean' },
      'backfill-garmin-elevation': { type: 'boolean' },
    },
  });
  if (!values.vault?.trim()) throw new Error('Pass the path to a vault directory with --vault PATH.');
  if (values.catalog) {
    if (values.input !== undefined || values.apply || values['backfill-garmin-elevation']) {
      throw new Error('Use --catalog on its own with --vault.');
    }
    return { mode: 'catalog' as const, vault: values.vault };
  }
  if (!values.input?.trim()) throw new Error('Pass an input JSON file with --input PATH, or stream JSON with --input -.');
  return { mode: values.apply ? 'apply' as const : 'plan' as const, vault: values.vault, input: values.input,
    backfillGarminElevation: values['backfill-garmin-elevation'] };
}

async function readInput(path: string): Promise<string> {
  if (path !== '-') return readFile(path, 'utf8');
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

function describeExercise(exercise: ExerciseChoice) {
  return {
    exerciseId: exercise.id,
    name: exercise.name,
    aliases: exercise.aliases,
    measurements: exercise.measurements,
    distanceUnit: exercise.measurements.includes('distance') ? exercise.distanceUnit : undefined,
    elevationUnit: exercise.measurements.includes('elevationGain') ? exercise.elevationUnit : undefined,
    archived: exercise.archived || undefined,
    starter: exercise.starter || undefined,
    missingNote: exercise.missingNote || undefined,
  };
}

function summarizePlan(plan: WorkoutImportPlan, data: LedgerData) {
  const names = new Map([...importExerciseCatalog(data), ...plan.exercises].map((exercise) => [exercise.id, exercise.name]));
  const resolvedExercises = new Map<string, { exerciseId: string; name: string; setCount: number }>();
  for (const workout of plan.workouts) {
    for (const set of workout.sets) {
      const existing = resolvedExercises.get(set.exerciseId);
      if (existing) {
        existing.setCount++;
      } else {
        resolvedExercises.set(set.exerciseId, {
          exerciseId: set.exerciseId, name: names.get(set.exerciseId) ?? set.exerciseName, setCount: 1,
        });
      }
    }
  }
  return {
    exercises: plan.exercises.map((exercise) => ({ exerciseId: exercise.id, name: exercise.name })),
    workouts: plan.workouts.map((workout) => ({ workoutId: workout.id, date: workout.date, setCount: workout.sets.length })),
    resolvedExercises: [...resolvedExercises.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skippedWorkoutIds: plan.skippedWorkoutIds,
  };
}

interface CommandResult {
  status: number;
  issues: ImportIssue[];
  details?: Record<string, unknown>;
}

async function runAgainstVault(root: string, mode: ImportMode, input: unknown, backfillGarminElevation?: boolean): Promise<CommandResult> {
  const vault = await readImportVault(root);
  if (vault.issues.length) return { status: 1, issues: vault.issues };
  if (mode === 'catalog') {
    return { status: 0, issues: [], details: { catalog: importExerciseCatalog(vault.data).map(describeExercise) } };
  }

  if (backfillGarminElevation) {
    const plan = await planGarminElevation(input, vault);
    const summary = { activities: plan.activities };
    if (plan.issues.length || mode === 'plan') {
      return { status: plan.issues.length ? 2 : 0, issues: plan.issues, details: { plan: summary } };
    }
    const { written, issues } = await writeGarminElevation(vault, plan);
    return { status: issues.length ? 1 : 0, issues, details: { written, plan: summary } };
  }

  const plan = await planWorkoutImport(input, vault.data);
  const summary = summarizePlan(plan, vault.data);
  if (plan.issues.length || mode === 'plan') {
    return { status: plan.issues.length ? 2 : 0, issues: plan.issues, details: { plan: summary } };
  }
  const { written, skippedWorkoutIds, issues } = await writeImportVault(vault, plan);
  summary.skippedWorkoutIds = [...new Set([...summary.skippedWorkoutIds, ...skippedWorkoutIds])];
  return { status: issues.length ? 1 : 0, issues, details: { written, plan: summary } };
}

async function main(args: string[]): Promise<void> {
  let mode: ImportMode = args.includes('--catalog') ? 'catalog' : args.includes('--apply') ? 'apply' : 'plan';
  let command: ReturnType<typeof parseCommand>;
  try {
    command = parseCommand(args);
    mode = command.mode;
  } catch (error: unknown) {
    respond(mode, 2, [{ code: 'INVALID_ARGUMENTS', path: 'arguments', message: errorMessage(error) }], { usage });
    return;
  }

  let input: unknown;
  if (command.mode !== 'catalog') {
    let text: string;
    try {
      text = await readInput(command.input);
    } catch (error: unknown) {
      respond(mode, 1, [{ code: 'INPUT_UNREADABLE', path: 'input', message: errorMessage(error) }]);
      return;
    }
    try {
      input = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    } catch (error: unknown) {
      respond(mode, 2, [{
        code: 'INVALID_JSON', path: 'input',
        message: `The import must be a valid JSON document. ${errorMessage(error)}`,
      }]);
      return;
    }
  }

  let result: CommandResult;
  let release: (() => Promise<void>) | undefined;
  let lockIssue: ImportIssue | undefined;
  try {
    const root = await resolveImportVaultRoot(command.vault);
    if (mode === 'apply') {
      const lock = await lockImportVault(root);
      if ('issue' in lock) {
        respond(mode, 1, [lock.issue]);
        return;
      }
      release = lock.release;
    }
    result = await runAgainstVault(root, mode, input, command.backfillGarminElevation);
  } catch (error: unknown) {
    result = { status: 1, issues: [{ code: 'VAULT_IMPORT_FAILED', path: 'vault', message: errorMessage(error) }] };
  } finally {
    if (release) {
      try {
        await release();
      } catch (error: unknown) {
        lockIssue = {
          code: 'VAULT_LOCK_RELEASE_FAILED', path: '.rep-journal-import.lock',
          message: `Could not release the import lock. ${errorMessage(error)} The written list shows completed files.`,
        };
      }
    }
  }
  if (lockIssue) {
    result.status = 1;
    result.issues.push(lockIssue);
  }
  respond(mode, result.status, result.issues, result.details);
}

await main(process.argv.slice(2));
