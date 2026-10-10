import {expect,it} from 'vitest';
import {inspectXPostText} from '../../social/xText.ts';

it('accepts the ordinary ASCII boundary and rejects a post beyond it',()=>{
 expect(inspectXPostText('x'.repeat(280))).toEqual({weightedLength:280,remaining:0,valid:true});
 expect(inspectXPostText('x'.repeat(281))).toEqual({weightedLength:281,remaining:-1,valid:false});
});

it('counts CJK text at double weight instead of admitting an overweight post',()=>{
 expect(inspectXPostText('界'.repeat(140))).toEqual({weightedLength:280,remaining:0,valid:true});
 expect(inspectXPostText('界'.repeat(141))).toEqual({weightedLength:282,remaining:-2,valid:false});
});

// Literal examples come from X's official Counting Characters guide, not the parser.
it('counts a complete family emoji as two and normalizes decomposed accents',()=>{
 expect(inspectXPostText('👨‍👩‍👧‍👦')).toEqual({weightedLength:2,remaining:278,valid:true});
 expect(inspectXPostText('cafe\u0301')).toEqual({weightedLength:4,remaining:276,valid:true});
});

it('uses the fixed URL weight for both short and long links',()=>{
 expect(inspectXPostText('https://example.com')).toEqual({weightedLength:23,remaining:257,valid:true});
 expect(inspectXPostText('https://example.com/very/long/path')).toEqual({weightedLength:23,remaining:257,valid:true});
});

it('refuses empty text and prohibited Unicode even below the length limit',()=>{
 expect(inspectXPostText('')).toEqual({weightedLength:0,remaining:280,valid:false});
 expect(inspectXPostText('hello\uFEFF')).toEqual({weightedLength:7,remaining:273,valid:false});
});
