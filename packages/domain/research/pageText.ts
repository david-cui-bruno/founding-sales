/**
 * Turning fetched page bytes into bounded blocks of published text.
 *
 * Ported from `59b3e1bb^:packages/domain/research/pageText.ts`, unchanged except that
 * `mailtoTargets` did not come across: v1 records no contact fact, so a page's
 * `mailto:` links are not read at all.
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

  const decoded = new TextDecoder('utf-8').decode(body).replaceAll(String.fromCharCode(0),'\uFFFD');
  const candidates = mime === 'text/plain' ? decoded.split(/\r?\n/u) : htmlLines(decoded);
  return assemble(mime === 'text/plain' ? candidates : candidates.map(decodeMarkupEntities));
}

/** The same bounds applied to already-plain text, for a provider that supplies it. */
export function blocksFromPlainText(text: string): PageText {
  return assemble(text.split(/\r?\n/u));
}

/** How many `<a href>` values one page may contribute. A bound, not a policy. */
export const MAX_ANCHOR_HREFS = 200;

/**
 * The raw `href` values of a page's anchors, in document order.
 *
 * A small lexical scan, on purpose: research needs a firm's own navigation to find
 * `/about-us` and `/join-our-team`, and it does not need — and must not grow — an HTML
 * parser to do it. Nothing here resolves, filters or trusts anything. The values come
 * back exactly as the page wrote them, including `mailto:`, `javascript:`, protocol-
 * relative and plainly broken ones; `discoverSameSiteUrls` in `sourcePolicy.ts` is
 * where every decision about them is made, and it is pure so those decisions are
 * provable without a page.
 *
 * Bounded twice over: nothing is scanned unless it is HTML inside `MAX_PAGE_BYTES`,
 * and at most `MAX_ANCHOR_HREFS` values come back.
 */
export function anchorHrefs(body: Uint8Array, contentType: string): readonly string[] {
  if (body.byteLength > MAX_PAGE_BYTES) return [];
  if (mediaTypeOf(contentType) !== 'text/html') return [];

  const source = new TextDecoder('utf-8').decode(body);
  const hrefs: string[] = [];
  const pattern = /<a\s[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`=]+))/giu;
  for (const match of source.matchAll(pattern)) {
    if (hrefs.length >= MAX_ANCHOR_HREFS) break;
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    const value = decodeMarkupEntities(raw).trim();
    if (value !== '') hrefs.push(value);
  }
  return Object.freeze(hrefs);
}

/**
 * The five predefined XML entities, which is what an `href` in real markup contains.
 *
 * `&amp;` is the one that matters: `?a=1&amp;b=2` is one URL written two ways, and
 * `discoverSameSiteUrls` drops the query anyway — but a numeric entity left in a path
 * would otherwise make two URLs out of one page.
 */
function decodeMarkupEntities(value: string): string {
  const named:Record<string,string>={quot:'"',apos:"'",lt:'<',gt:'>',amp:'&',nbsp:' '};
  return value.replace(/&(#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7})|quot|apos|lt|gt|amp|nbsp);/giu,(_,token:string)=>{
    if(token.startsWith('#'))return codePoint(token[1]?.toLowerCase()==='x'?Number.parseInt(token.slice(2),16):Number.parseInt(token.slice(1),10));
    return named[token.toLowerCase()]??'';
  });
}

function codePoint(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value>=0xd800 && value<=0xdfff)) return '\uFFFD';
  return String.fromCodePoint(value);
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
    // Raw text is not HTML: a JavaScript '<' must not consume the closing script
    // tag as if it were another opening tag. No script or style bytes become text.
    if(droppedName!==null && ['script','style','title','textarea','xmp','iframe','noembed','noframes'].includes(droppedName)) {
      const close=new RegExp(`</\\s*${droppedName}\\s*>`,'iu').exec(source.slice(position));
      if(close===null)break;
      position+=close.index+close[0].length;droppedName=null;droppedDepth=0;continue;
    }
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
