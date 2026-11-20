export interface NoteDraft {
  original: string;
  value: string;
}

export class WorkoutNoteDrafts {
  private readonly drafts = new Map<string, NoteDraft>();

  get(date: string, workoutId: string | null): NoteDraft | undefined {
    return this.drafts.get(workoutId ?? date);
  }

  save(date: string, workoutId: string | null, draft: NoteDraft): void {
    const key = workoutId ?? date;
    if (draft.value === draft.original) this.drafts.delete(key);
    else this.drafts.set(key, draft);
  }

  associate(date: string, workoutId: string): void {
    const draft = this.drafts.get(date);
    if (draft) {
      this.drafts.delete(date);
      this.drafts.set(workoutId, draft);
    }
  }
}
