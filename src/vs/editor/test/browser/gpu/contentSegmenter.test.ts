/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { computeLigatureSegments } from '../../../browser/gpu/contentSegmenter.js';

suite('Ligature content segmenter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function compute(content: string, maxLigatureLength: number, breaks: number[] = []): (string | undefined)[] {
		const breakAfter = new Uint8Array(content.length);
		for (const index of breaks) {
			breakAfter[index] = 1;
		}
		return computeLigatureSegments(content, breakAfter, maxLigatureLength);
	}

	test('does not group characters when ligatures are disabled', () => {
		deepStrictEqual(compute('a=>b', 1), ['a', '=', '>', 'b']);
	});

	test('groups consecutive operator characters', () => {
		deepStrictEqual(compute('a => b', 3), ['a', ' ', '=>', undefined, ' ', 'b']);
		deepStrictEqual(compute('x!=y;', 3), ['x', '!=', undefined, 'y', ';']);
	});

	test('groups up to the maximum ligature length', () => {
		deepStrictEqual(compute('======', 3), ['===', undefined, undefined, '===', undefined, undefined]);
		deepStrictEqual(compute('======', 2), ['==', undefined, '==', undefined, '==', undefined]);
	});

	test('does not group alphanumeric characters', () => {
		deepStrictEqual(compute('fi => fl', 3), ['f', 'i', ' ', '=>', undefined, ' ', 'f', 'l']);
	});

	test('does not group across a break', () => {
		// A break after index 0 prevents `=` and `>` from being shaped together
		deepStrictEqual(compute('=>', 3, [0]), ['=', '>']);
		// A break after index 2 splits a longer run
		deepStrictEqual(compute('====', 3, [2]), ['===', undefined, undefined, '=']);
	});

	test('handles empty content', () => {
		deepStrictEqual(compute('', 3), []);
	});
});
