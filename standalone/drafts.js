export class WorkoutNoteDrafts {
  #drafts = new Map();

  get(date, workoutId) {
    return this.#drafts.get(workoutId ?? date);
  }

  clear(date, workoutId) {
    this.#drafts.delete(workoutId ?? date);
  }

  save(date, workoutId, draft) {
    if (draft.value === draft.original) this.clear(date, workoutId);
    else this.#drafts.set(workoutId ?? date, draft);
  }

  associate(date, workoutId) {
    const draft = this.get(date, null);
    if (!draft) return;
    this.clear(date, null);
    this.save(date, workoutId, draft);
  }
}
