// Parse HTML with browser tree-building rules, then emit only inert markup.
// Never return guest tags or attributes by copying source HTML.
import { parse, type DefaultTreeAdapterMap } from 'parse5'
const tags = new Set('html head body title h1 h2 h3 h4 h5 h6 p div span a b strong i em u s small sub sup mark code pre blockquote ul ol li dl dt dd table caption thead tbody tfoot tr th td br hr button details summary'.split(' '))
const discard = new Set('script style template iframe object embed noscript noembed noframes plaintext xmp textarea'.split(' '))
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export function staticHtml(source: string, ceiling: number): string {
  const chunks = ['<!doctype html>']; let bytes = Buffer.byteLength(chunks[0])
  function append(value: string) {
    bytes += Buffer.byteLength(value)
    if (bytes > ceiling) throw new Error('rendered HTML exceeds response ceiling')
    chunks.push(value)
  }
  type Node = DefaultTreeAdapterMap['node']
  const pending: (Node | string)[] = [parse(source)]
  while (pending.length) {
    const node = pending.pop()!
    if (typeof node === 'string') { append(node); continue }
    if (node.nodeName === '#text') { append(escape((node as DefaultTreeAdapterMap['textNode']).value)); continue }
    if ('tagName' in node) {
      // Drop foreign trees entirely. SVG/MathML have their own URL and parser rules.
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || discard.has(node.tagName)) continue
      if (tags.has(node.tagName)) {
        let attrs = node.tagName === 'button' ? ' type="button"' : ''
        for (const attr of node.attrs) {
          if (!attr.namespace && ['id', 'title', 'lang'].includes(attr.name)) attrs += ` ${attr.name}="${escape(attr.value)}"`
          if (!attr.namespace && attr.name === 'dir' && ['ltr', 'rtl', 'auto'].includes(attr.value)) attrs += ` dir="${attr.value}"`
          if (!attr.namespace && ['td', 'th'].includes(node.tagName) && ['colspan', 'rowspan'].includes(attr.name) && /^[1-9][0-9]?$/.test(attr.value)) attrs += ` ${attr.name}="${attr.value}"`
        }
        append(`<${node.tagName}${attrs}>`)
        if (!['br', 'hr'].includes(node.tagName)) pending.push(`</${node.tagName}>`)
      }
    }
    if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i])
  }
  return chunks.join('')
}
