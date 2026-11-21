interface NoteDraft {
  original: string;
  value: string;
  newWorkoutId?: string;
}

export class WorkoutNoteDrafts {
  get(date: string, workoutId: string | null): NoteDraft | undefined;
  clear(date: string, workoutId: string | null): void;
  save(date: string, workoutId: string | null, draft: NoteDraft): void;
  associate(date: string, workoutId: string): void;
}
