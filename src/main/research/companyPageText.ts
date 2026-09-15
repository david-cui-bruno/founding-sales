import { load } from 'cheerio/slim';

export type CompanyPageText = { text: string; blocks: { id: string; text: string }[]; truncated: boolean };
const MAX_BYTES = 1_000_000;
const boundaries = new Set(['address', 'aside', 'br', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'td', 'th', 'ul']);

/** Pure publication text, not a visibility engine or evidence-permission decision.
 * Oversized input is rejected wholesale before decoding/parsing: a cut tag must
 * never manufacture a published block. Every retained block is complete. */
export function parseCompanyPageText(body: Uint8Array, contentType: string): CompanyPageText {
  const result: CompanyPageText = { text: '', blocks: [], truncated: false };
  if (body.byteLength > MAX_BYTES) return { ...result, truncated: true };
  const mime = contentType.split(';')[0]?.trim().toLowerCase();
  if (mime !== 'text/html' && mime !== 'text/plain') return result;
  const decoded = new TextDecoder('utf-8').decode(body);
  const candidates: string[] = [];
  if (mime === 'text/plain') {
    for (const line of decoded.split(/\r?\n/)) candidates.push(line);
  }
  else {
    const $ = load(decoded);
    $('script,style,template,noscript,svg,iframe,textarea,title,blockquote,article,xmp,noembed,noframes,[hidden]').remove();
    $('[aria-hidden]').each((_i, element) => {
      if ($(element).attr('aria-hidden')?.trim().toLowerCase() === 'true') $(element).remove();
    });
    $('[style]').each((_i, element) => {
      const style = ($(element).attr('style') ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(style)) $(element).remove();
    });
    let pending = '';
    const flush = () => { if (pending) candidates.push(pending); pending = ''; };
    // Iterative traversal avoids recursion failure on adversarial nested markup.
    // Infer DOM node types from the actual parser rather than a second DOM package.
    const stack = $.root().contents().toArray().reverse().map(node => ({ node, exit: false }));
    while (stack.length) {
      const entry = stack.pop()!;
      const node = entry.node;
      if (entry.exit) { flush(); continue; }
      if (node.type === 'text') { pending += node.data; continue; }
      if (!('children' in node)) continue;
      const boundary = 'name' in node && boundaries.has(node.name);
      if (boundary) { flush(); stack.push({ node, exit: true }); }
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i]!, exit: false });
    }
    flush();
  }
  for (const candidate of candidates) {
    const text = candidate.replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    const separator = result.blocks.length ? '\n\n' : '';
    if (result.blocks.length >= 100 || result.text.length + separator.length + text.length > 12000) {
      result.truncated = true;
      continue;
    }
    result.blocks.push({ id: `b${result.blocks.length + 1}`, text });
    result.text += separator + text;
  }
  return result;
}
