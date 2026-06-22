export function highlight(text: string, q: string): (string | JSX.Element)[] {
  const terms = q.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [text];
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const out: (string | JSX.Element)[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={key++} className="bg-vermilion/20 text-fg">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
