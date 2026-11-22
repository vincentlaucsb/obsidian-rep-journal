interface NoteDraft {
  original: string;
  value: string;
  newWorkoutId?: string;
}

export class WorkoutNoteDrafts {
  #drafts = new Map<string, NoteDraft>();

  get(date: string, workoutId: string | null): NoteDraft | undefined {
    return this.#drafts.get(workoutId ?? date);
  }

  clear(date: string, workoutId: string | null): void {
    this.#drafts.delete(workoutId ?? date);
  }

  save(date: string, workoutId: string | null, draft: NoteDraft): void {
    if (draft.value === draft.original) this.clear(date, workoutId);
    else this.#drafts.set(workoutId ?? date, draft);
  }

  associate(date: string, workoutId: string): void {
    const draft = this.get(date, null);
    if (!draft) return;
    this.clear(date, null);
    this.save(date, workoutId, draft);
  }
}
