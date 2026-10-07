import { describe, expect, it } from 'vitest';
import { ratio, setDifference, setIntersection } from '../src/analytics';
describe('analytics',()=>{it('difference',()=>expect(setDifference(new Set(['a','b']),new Set(['b']))).toEqual(['a']));it('intersection',()=>expect(setIntersection(new Set(['a','b']),new Set(['b','c']))).toEqual(['b']));it('ratio',()=>expect(ratio(2,4)).toBe(.5));});
