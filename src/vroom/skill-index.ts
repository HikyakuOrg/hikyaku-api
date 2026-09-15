/**
 * Maps an organisation's skill catalog ids (skills.id, uuid) to small
 * integers for ONE VROOM request.
 *
 * VROOM only compares `skills` arrays within a single solve — see
 * VroomJob.skills / VroomVehicle.skills — so the mapping needs no global
 * stability. A fresh index per request, scoped to exactly the ids that
 * request's jobs and vehicles use, keeps the integers small and keeps
 * every caller building a VroomRequest (DatabaseService, ReplanWorker)
 * free of any shared state between requests. See HIK-90/HIK-92.
 */
export class SkillIndex {
    private readonly byId = new Map<string, number>();
    private next = 1;

    /** Registers every id in every array, skipping one already registered. */
    register(idSets: Iterable<readonly string[] | null | undefined>): void {
        for (const ids of idSets) {
            if (!ids) continue;
            for (const id of ids) {
                if (!this.byId.has(id)) this.byId.set(id, this.next++);
            }
        }
    }

    /**
     * The integers for a set of ids, or `undefined` for none/empty — matching
     * VROOM's own default of no skill requirement, and keeping a VroomJob/
     * VroomVehicle with nothing to say about skills byte-identical to one
     * built before this feature existed.
     *
     * Throws if an id was never registered. That is a caller bug (every id
     * this method is asked about must have gone through `register` first,
     * typically by registering the same rows this is now reading skills
     * off), not a data condition to degrade gracefully from.
     */
    indicesFor(
        ids: readonly string[] | null | undefined,
    ): number[] | undefined {
        if (!ids || ids.length === 0) return undefined;
        return ids.map((id) => {
            const index = this.byId.get(id);
            if (index === undefined) {
                throw new Error(
                    `Skill id ${id} was never registered with this SkillIndex.`,
                );
            }
            return index;
        });
    }
}
