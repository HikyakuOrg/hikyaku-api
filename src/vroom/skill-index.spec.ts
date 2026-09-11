import { SkillIndex } from './skill-index';

describe('SkillIndex', () => {
    it('returns undefined for no ids, matching VROOM default of no requirement', () => {
        const index = new SkillIndex();
        expect(index.indicesFor(undefined)).toBeUndefined();
        expect(index.indicesFor(null)).toBeUndefined();
        expect(index.indicesFor([])).toBeUndefined();
    });

    it('assigns small integers starting at 1', () => {
        const index = new SkillIndex();
        index.register([['skill-a', 'skill-b']]);
        expect(index.indicesFor(['skill-a'])).toEqual([1]);
        expect(index.indicesFor(['skill-b'])).toEqual([2]);
    });

    it('gives the same id the same integer everywhere it appears', () => {
        const index = new SkillIndex();
        index.register([['skill-a'], ['skill-b', 'skill-a']]);
        expect(index.indicesFor(['skill-a'])).toEqual([1]);
        expect(index.indicesFor(['skill-b', 'skill-a'])).toEqual([2, 1]);
    });

    it('skips null/undefined sets when registering', () => {
        const index = new SkillIndex();
        index.register([null, undefined, ['skill-a']]);
        expect(index.indicesFor(['skill-a'])).toEqual([1]);
    });

    it('throws for an id that was never registered', () => {
        const index = new SkillIndex();
        index.register([['skill-a']]);
        expect(() => index.indicesFor(['skill-unknown'])).toThrow(
            /never registered/,
        );
    });
});
