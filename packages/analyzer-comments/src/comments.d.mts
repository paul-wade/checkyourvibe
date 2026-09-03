/** One comment as written, positioned at its opening delimiter (1-based). */
export interface ExtractedComment {
  text: string;
  line: number;
  column: number;
}

/** A comment after adjacent line comments have been joined into one remark. */
export interface MergedComment extends ExtractedComment {
  lineSpan: number;
}

/** Comment and string delimiters for one file extension. */
export interface CommentSyntax {
  line: string[];
  block: Array<[string, string]>;
  strings: string[];
}

export function syntaxFor(extension: string): CommentSyntax | undefined;
export function supportedExtensions(): string[];
export function extractComments(text: string, syntax: CommentSyntax): ExtractedComment[];
export function mergeAdjacent(comments: readonly ExtractedComment[]): MergedComment[];
