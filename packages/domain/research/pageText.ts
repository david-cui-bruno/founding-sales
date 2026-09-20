/**
 * Turning fetched page bytes into bounded blocks of published text.
 *
 * Ported from `src/main/research/companyPageText.ts` and the `htmlText` tokenizer in
 * `companyPageProvider.ts`. The old parser used `cheerio`; this one does not, because
 * the greenfield tree adds no dependency it can avoid and the conservative lexical
 * rules below are the part that actually mattered.
 *
 * Three rules, all inherited, all about not manufacturing a fact:
 *
 *   * **Oversized input is refused whole.** A truncated tag can turn markup into
 *     text, and a block that was never published must never become a quote. So a body
 *     over `MAX_BYTES` yields no blocks at all and says it was truncated.
 *   * **Only complete markup is tokenized.** An unterminated tag or an unclosed
 *     raw-text element stops the scan; whatever follows stays markup for ever.
 *   * **Attribution containers are dropped.** `blockquote`, `article`, testimonials
 *     and `noscript` are removed, because a customer's words on a firm's site are not
 *     the firm's statement about itself, and section 7.4's evidence is about the firm.
 *
 * A block is whole. Nothing here cuts one in half to fit a budget: a block that does
 * not fit is dropped and `truncated` says so. That is what lets the extraction step
 * check a quote against the exact text of a block and refuse anything else.
 */

export interface PageBlock {
  /** Stable within one page: `b1`, `b2`, … The extractor addresses blocks by this. */
  readonly id: string;
  readonly text: string;
}

export interface PageText {
  readonly blocks: readonly PageBlock[];
  /** The blocks joined, which is what a person reads back as the excerpt. */
  readonly text: string;
  /** True when something was left out: oversized input, or the block/character bound. */
  readonly truncated: boolean;
}

/** A page larger than this is not parsed at all. One megabyte, as the old module had. */
export const MAX_PAGE_BYTES = 1_000_000;
export const MAX_BLOCKS = 100;
export const MAX_TEXT_CHARACTERS = 12_000;

/** Elements whose boundaries end a block of text. */
const BLOCK_BOUNDARIES: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'br', 'div', 'dd', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol',
  'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul',
]);

/**
 * Elements whose contents are not published text. `article` and `blockquote` are here
 * rather than in the boundary set because their *contents* are dropped: a testimonial
 * is somebody else's statement.
 */
const DROPPED_CONTAINERS: ReadonlySet<string> = new Set([
  'article', 'blockquote', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'script',
  'style', 'svg', 'template', 'textarea', 'title', 'xmp',
]);

const MIME_PATTERN = /^(text\/html|text\/plain)$/u;

/** The media type of a `content-type` header value, lower-cased, without parameters. */
export function mediaTypeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Parse one fetched page into blocks.
 *
 * `body` is the exact bytes the fetch read, so the caller's content hash and these
 * blocks describe the same thing.
 */
export function parsePageText(body: Uint8Array, contentType: string): PageText {
  const empty: PageText = { blocks: [], text: '', truncated: false };
  if (body.byteLength > MAX_PAGE_BYTES) return { ...empty, truncated: true };
  const mime = mediaTypeOf(contentType);
  if (!MIME_PATTERN.test(mime)) return empty;

  const decoded = new TextDecoder('utf-8').decode(body);
  const candidates = mime === 'text/plain' ? decoded.split(/\r?\n/u) : htmlLines(decoded);
  return assemble(candidates);
}

/** The same bounds applied to already-plain text, for a provider that supplies it. */
export function blocksFromPlainText(text: string): PageText {
  return assemble(text.split(/\r?\n/u));
}

function assemble(candidates: readonly string[]): PageText {
  const blocks: PageBlock[] = [];
  let text = '';
  let truncated = false;
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\s+/gu, ' ').trim();
    if (normalized === '') continue;
    const separator = blocks.length === 0 ? '' : '\n\n';
    if (blocks.length >= MAX_BLOCKS || text.length + separator.length + normalized.length > MAX_TEXT_CHARACTERS) {
      // Dropped whole, never cut. A half block would be a quote nobody published.
      truncated = true;
      continue;
    }
    blocks.push({ id: `b${String(blocks.length + 1)}`, text: normalized });
    text += separator + normalized;
  }
  return { blocks, text, truncated };
}

/**
 * A conservative lexical scan of HTML into candidate lines.
 *
 * Deliberately not a browser. It does not compute layout, does not evaluate CSS
 * beyond the three inline declarations that plainly hide an element, and stops rather
 * than guessing at anything it cannot tokenize completely.
 */
function htmlLines(source: string): string[] {
  const lines: string[] = [];
  let pending = '';
  let position = 0;
  /**
   * The element whose contents are being discarded, and how deep the same element is
   * nested inside itself. Tracking the name is what lets a lexical scan find the
   * matching close tag; tracking the depth is what stops an inner `<div>` inside a
   * hidden `<div>` ending the region early.
   */
  let droppedName: string | null = null;
  let droppedDepth = 0;

  const flush = (): void => {
    if (pending !== '') lines.push(pending);
    pending = '';
  };

  while (position < source.length) {
    const character = source[position];
    if (character !== '<') {
      if (droppedName === null) pending += character;
      position += 1;
      continue;
    }
    if (source.startsWith('<!--', position)) {
      const end = source.indexOf('-->', position + 4);
      if (end < 0) break; // An unterminated comment: everything after it stays markup.
      position = end + 3;
      continue;
    }

    // Find the end of the tag, respecting quoted attribute values.
    let end = position + 1;
    let quote: string | null = null;
    for (; end < source.length; end += 1) {
      const inside = source[end];
      if (quote !== null) {
        if (inside === quote) quote = null;
      } else if (inside === '"' || inside === "'") {
        quote = inside;
      } else if (inside === '>') {
        break;
      }
    }
    if (end >= source.length) break; // An unterminated tag. Stop; never guess.

    const markup = source.slice(position, end + 1);
    position = end + 1;
    const parsed = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/iu.exec(markup);
    const closing = parsed?.[1] === '/';
    const selfClosing = markup.endsWith('/>');
    const name = parsed?.[2]?.toLowerCase();

    if (droppedName !== null) {
      // Inside a region whose contents are not published text. Only the matching
      // close tag ends it, and a nested element of the same name does not.
      if (name === droppedName) {
        if (closing) {
          droppedDepth -= 1;
          if (droppedDepth <= 0) droppedName = null;
        } else if (!selfClosing) {
          droppedDepth += 1;
        }
      }
      continue;
    }

    // Two reasons to discard an element's contents: it is an attribution or raw-text
    // container, or an inline style plainly hides it. Both are the same treatment,
    // because in both cases the text inside was never published to a reader.
    if (name !== undefined && !closing && !selfClosing && (DROPPED_CONTAINERS.has(name) || hiddenByInlineStyle(markup))) {
      flush();
      droppedName = name;
      droppedDepth = 1;
      continue;
    }
    if (name !== undefined && DROPPED_CONTAINERS.has(name)) continue;

    if (name === undefined || BLOCK_BOUNDARIES.has(name)) flush();
  }
  flush();
  return lines;
}

const HIDING_DECLARATION =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/iu;

function hiddenByInlineStyle(markup: string): boolean {
  if (/\saria-hidden\s*=\s*(["'])\s*true\s*\1/iu.test(markup)) return true;
  if (/\shidden(?=[\s/>=])/iu.test(markup)) return true;
  const style = /\sstyle\s*=\s*(["'])([^"']*)\1/iu.exec(markup)?.[2];
  if (style === undefined) return false;
  return HIDING_DECLARATION.test(style.replace(/\/\*[\s\S]*?\*\//gu, ''));
}

/**
 * The `mailto:` addresses a page's markup carries, from complete quoted `href`
 * attributes only. Ported from `mailtoTargets`: a firm often publishes its inbox as a
 * link whose visible text is an image or a person's name, so the rendered text alone
 * would miss it. Only the address is taken; any `?subject=` tail is discarded.
 */
export function mailtoTargets(source: string): readonly string[] {
  const targets: string[] = [];
  for (const match of source.matchAll(
    /href[\t\n\f\r ]*=[\t\n\f\r ]*(["'])[\t\n\f\r ]*mailto:([^"'?\s]{3,254})(?:\?[^"']*)?\1/giu,
  )) {
    const value = match[2];
    if (value !== undefined) targets.push(value);
  }
  return targets;
}
