import { matchesExerciseName, suggestExercises } from './catalog.ts';
import { type ExerciseChoice, type WorkoutChange } from './model.ts';

export interface PlanExercise {
  name: string;
  exerciseId: string;
  notes: string;
}

export interface PlanSection {
  name: string;
  superset: boolean;
  notes: string;
  exercises: PlanExercise[];
}

export interface WorkoutPlan {
  title?: string;
  notes: string;
  sections: PlanSection[];
}

export interface PlanIssue {
  line: number;
  message: string;
}

export interface PlanPosition {
  sectionIndex: number;
  exerciseIndex: number;
}

type DraftExercise = Omit<PlanExercise, 'notes'> & { notes: string[] };
type DraftSection = Omit<PlanSection, 'notes' | 'exercises'> & { line: number; notes: string[]; exercises: DraftExercise[] };

export function parseWorkoutPlan(markdown: string, exercises: readonly ExerciseChoice[]):
  { plan: WorkoutPlan; issues?: never } | { plan?: never; issues: PlanIssue[] } {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  const issues: PlanIssue[] = [];
  const firstLine = frontmatterEnd(lines);
  if (firstLine < 0) return { issues: [{ line: 1, message: 'Close the note properties with a line containing ---.' }] };

  const introduction: string[] = [];
  const sections: DraftSection[] = [];
  let title: string | undefined;
  let section: DraftSection | undefined;
  let notes = introduction;
  let fence = '';
  let commentEnd = '';
  for (let index = firstLine; index < lines.length; index++) {
    const text = lines[index];
    const line = index + 1;
    if (commentEnd) {
      notes.push(text);
      if (text.includes(commentEnd)) commentEnd = '';
      continue;
    }

    const marker = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      notes.push(text);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      notes.push(text);
      continue;
    }
    const comment = /^ {0,3}(<!--|%%)/.exec(text);
    if (comment) {
      const end = comment[1] === '<!--' ? '-->' : '%%';
      if (!text.includes(end, comment[0].length)) commentEnd = end;
      notes.push(text);
      continue;
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(text);
    const level = heading?.[1].length;
    const name = heading?.[2]?.replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim() ?? '';
    if (level === 1 && name && title === undefined && !sections.length && !introduction.some((part) => part.trim())) {
      title = name;
    } else if (level === 2) {
      section = undefined;
      notes = [];
      if (!name) {
        issues.push({ line, message: 'Give this ## section a name.' });
        continue;
      }
      section = { name, line, superset: false, notes, exercises: [] };
      sections.push(section);
      const modeLine = nextNonblankLine(lines, index + 1);
      const mode = /^ {0,3}Mode:[ \t]*(.*)$/i.exec(lines[modeLine] ?? '');
      if (mode) {
        section.superset = mode[1].trim().toLowerCase() === 'superset';
        if (!section.superset) issues.push({ line: modeLine + 1, message: 'Use Mode: superset or remove the mode line.' });
        index = modeLine;
      }
    } else if (level === 3) {
      notes = [];
      if (!section) issues.push({ line, message: 'Put this ### exercise beneath a named ## section.' });
      else if (!name) issues.push({ line, message: 'Enter an exercise name or alias after ###.' });
      else {
        const exerciseId = resolveExercise(name, line, exercises, issues);
        if (exerciseId) section.exercises.push({ name, exerciseId, notes });
      }
    } else {
      notes.push(text);
    }
  }

  if (!issues.length) {
    if (!sections.length) issues.push({ line: firstLine + 1, message: 'Add a ## heading to start a workout section.' });
    else if (!sections.some((entry) => entry.exercises.length)) {
      issues.push({ line: sections[0].line, message: 'Add at least one ### exercise heading to the plan.' });
    }
    for (const entry of sections) {
      if (entry.superset && entry.exercises.length < 2) {
        issues.push({ line: entry.line, message: 'A superset needs at least two ### exercise headings.' });
      }
    }
  }
  if (issues.length) return { issues };
  return {
    plan: {
      title, notes: markdownNotes(introduction),
      sections: sections.map(({ name, superset, notes: sectionNotes, exercises: entries }) => ({
        name, superset, notes: markdownNotes(sectionNotes),
        exercises: entries.map((entry) => ({ ...entry, notes: markdownNotes(entry.notes) })),
      })),
    },
  };
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0].trimEnd() !== '---') return 0;
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.{3})[ \t]*$/.test(line));
  return end < 0 ? -1 : end + 1;
}

function nextNonblankLine(lines: string[], index: number): number {
  while (index < lines.length && !lines[index].trim()) index++;
  return index;
}

function markdownNotes(lines: string[]): string {
  const first = nextNonblankLine(lines, 0);
  let end = lines.length;
  while (end > first && !lines[end - 1].trim()) end--;
  return lines.slice(first, end).join('\n');
}

function resolveExercise(name: string, line: number, exercises: readonly ExerciseChoice[], issues: PlanIssue[]): string | undefined {
  const matches = exercises.filter((exercise) => matchesExerciseName(exercise, name, true));
  const available = matches.filter((exercise) => !exercise.archived && !exercise.missingNote);
  if (available.length === 1) return available[0].id;
  if (available.length > 1) {
    const names = available.map((exercise) => `“${exercise.name}”`).join(', ');
    issues.push({ line, message: `“${name}” matches more than one exercise (${names}). Use a unique name or alias.` });
  } else if (matches.length) {
    issues.push({ line, message: `“${name}” is archived or its exercise note is missing. Restore it or choose another exercise.` });
  } else {
    const suggestions = suggestExercises(name, exercises.filter((exercise) => !exercise.archived && !exercise.missingNote));
    const hint = suggestions.length ? ` Possible matches: ${suggestions.map((exercise) => exercise.name).join(', ')}.` : '';
    issues.push({ line, message: `No exercise matches “${name}”. Use an existing name or alias.${hint}` });
  }
}

export function advanceWorkoutPlan(plan: WorkoutPlan, position: PlanPosition, change: WorkoutChange): PlanPosition {
  const section = plan.sections[position.sectionIndex];
  const selected = section?.exercises[position.exerciseIndex];
  if (change.kind !== 'add' || !section?.superset || selected?.exerciseId !== change.set.exerciseId) return position;
  return { ...position, exerciseIndex: (position.exerciseIndex + 1) % section.exercises.length };
}
