import { describe, expect, it } from 'vitest';
import { normalizeUsername, usernameFromEntry, uniqueNormalized } from '../src/normalize';
describe('normalize',()=>{it('normalizes handles',()=>expect(normalizeUsername(' @John.Doe ')).toBe('john.doe'));it('rejects deleted',()=>expect(normalizeUsername('__deleted__123')).toBeNull());it('reads Instagram structures',()=>{expect(usernameFromEntry({title:'John'})).toBe('john');expect(usernameFromEntry({string_list_data:[{value:'Jane'}]})).toBe('jane')});it('dedupes',()=>expect(uniqueNormalized(['A','a','@B'])).toEqual(['a','b']));});
