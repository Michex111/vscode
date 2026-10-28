/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeIntl } from '../../../base/common/date.js';
import type { GraphemeIterator } from '../../../base/common/strings.js';
import { EditorFontLigatures } from '../../common/config/editorOptions.js';
import type { IViewLineTokens } from '../../common/tokens/lineTokens.js';
import type { ViewLineRenderingData } from '../../common/viewModel.js';
import type { ViewLineOptions } from '../viewParts/viewLines/viewLineOptions.js';

export interface IContentSegmenter {
	/**
	 * Gets the content segment at an index within the line data's contents. This will be undefined
	 * when the index should not be rendered, ie. when it's part of an earlier segment like the tail
	 * end of an emoji, or when the line is not that long.
	 * @param index The index within the line data's content string.
	 */
	getSegmentAtIndex(index: number): string | undefined;
	getSegmentData(index: number): Intl.SegmentData | undefined;
}

export function createContentSegmenter(lineData: ViewLineRenderingData, options: ViewLineOptions, maxLigatureLength: number): IContentSegmenter {
	if (lineData.isBasicASCII && options.useMonospaceOptimizations) {
		// Ligatures are only supported in the monospace grid based rendering path as a ligature
		// segment is assumed to span exactly one column per character it contains.
		if (maxLigatureLength > 1 && options.fontLigatures !== EditorFontLigatures.OFF) {
			return new LigatureContentSegmenter(lineData, maxLigatureLength);
		}
		return new AsciiContentSegmenter(lineData);
	}
	return new GraphemeContentSegmenter(lineData);
}

class AsciiContentSegmenter implements IContentSegmenter {
	private readonly _content: string;

	constructor(lineData: ViewLineRenderingData) {
		this._content = lineData.content;
	}

	getSegmentAtIndex(index: number): string {
		return this._content[index];
	}

	getSegmentData(index: number): Intl.SegmentData | undefined {
		return undefined;
	}
}

/**
 * This is a more modern version of {@link GraphemeIterator}, relying on browser APIs instead of a
 * manual table approach.
 */
class GraphemeContentSegmenter implements IContentSegmenter {
	private readonly _segments: (Intl.SegmentData | undefined)[] = [];

	constructor(lineData: ViewLineRenderingData) {
		const content = lineData.content;
		const segmenter = safeIntl.Segmenter(undefined, { granularity: 'grapheme' }).value;
		const segmentedContent = Array.from(segmenter.segment(content));
		let segmenterIndex = 0;

		for (let x = 0; x < content.length; x++) {
			const segment = segmentedContent[segmenterIndex];

			// No more segments in the string (eg. an emoji is the last segment)
			if (!segment) {
				break;
			}

			// The segment isn't renderable (eg. the tail end of an emoji)
			if (segment.index !== x) {
				this._segments.push(undefined);
				continue;
			}

			segmenterIndex++;
			this._segments.push(segment);
		}
	}

	getSegmentAtIndex(index: number): string | undefined {
		return this._segments[index]?.segment;
	}

	getSegmentData(index: number): Intl.SegmentData | undefined {
		return this._segments[index];
	}
}

/**
 * Segments the content into renderable segments, grouping consecutive characters that may form a
 * ligature into a single segment. Only the first index of such a group returns a segment, the
 * remaining indices return `undefined`. This allows the browser to shape all characters of a group
 * in one go, which is a prerequisite for OpenType ligature substitution to happen.
 */
class LigatureContentSegmenter implements IContentSegmenter {
	private readonly _segments: (string | undefined)[];

	constructor(lineData: ViewLineRenderingData, maxLigatureLength: number) {
		this._segments = computeLigatureSegments(
			lineData.content,
			computeLigatureBreakAfter(lineData),
			maxLigatureLength
		);
	}

	getSegmentAtIndex(index: number): string | undefined {
		return this._segments[index];
	}

	getSegmentData(index: number): Intl.SegmentData | undefined {
		return undefined;
	}
}

/**
 * Computes a mask where `breakAfter[index] === 1` means a ligature segment starting at or before
 * `index` must not include `index + 1`. A segment cannot span a token or inline decoration
 * boundary as the entire segment is rasterized using a single token metadata and decoration style.
 */
function computeLigatureBreakAfter(lineData: ViewLineRenderingData): Uint8Array {
	const breakAfter = new Uint8Array(lineData.content.length);
	markTokenBoundaries(lineData.tokens, breakAfter);
	for (const decoration of lineData.inlineDecorations) {
		// Break right before the decoration starts and right after it ends
		markBreakAfter(breakAfter, decoration.range.startColumn - 2);
		markBreakAfter(breakAfter, decoration.range.endColumn - 2);
	}
	// Only the columns from `minColumn` onwards are rendered
	markBreakAfter(breakAfter, lineData.minColumn - 2);
	return breakAfter;
}

function markTokenBoundaries(tokens: IViewLineTokens, breakAfter: Uint8Array): void {
	for (let i = 0, len = tokens.getCount(); i < len; i++) {
		markBreakAfter(breakAfter, tokens.getEndOffset(i) - 1);
	}
}

function markBreakAfter(breakAfter: Uint8Array, index: number): void {
	if (index >= 0 && index < breakAfter.length) {
		breakAfter[index] = 1;
	}
}

/**
 * Whether a character may participate in a programming ligature (eg. `=>`, `!=`, `::`).
 * Alphanumeric characters are excluded as programming fonts rarely ligate them and grouping
 * identifiers would prevent the glyph atlas from reusing glyphs.
 */
function isLigatureCandidate(charCode: number): boolean {
	return charCode > 0x20 /* space */
		&& charCode < 0x7f /* DEL */
		&& !(charCode >= 0x30 && charCode <= 0x39) // 0-9
		&& !(charCode >= 0x41 && charCode <= 0x5a) // A-Z
		&& !(charCode >= 0x61 && charCode <= 0x7a); // a-z
}

/**
 * Computes the segments of a line, grouping up to `maxLigatureLength` consecutive ligature
 * candidate characters into a single segment.
 *
 * @internal
 */
export function computeLigatureSegments(content: string, breakAfter: Uint8Array, maxLigatureLength: number): (string | undefined)[] {
	const segments: (string | undefined)[] = new Array(content.length);
	let index = 0;
	while (index < content.length) {
		if (isLigatureCandidate(content.charCodeAt(index))) {
			let end = index + 1;
			while (
				end < content.length
				&& end - index < maxLigatureLength
				&& isLigatureCandidate(content.charCodeAt(end))
				&& !breakAfter[end - 1]
			) {
				end++;
			}
			if (end - index > 1) {
				segments[index] = content.substring(index, end);
				for (let i = index + 1; i < end; i++) {
					segments[i] = undefined;
				}
				index = end;
				continue;
			}
		}
		segments[index] = content[index];
		index++;
	}
	return segments;
}
