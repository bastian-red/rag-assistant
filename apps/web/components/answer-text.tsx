import type { ReactNode } from 'react';

import { parseAnswer, type Inline } from '../lib/answer';

interface Props {
  readonly text: string;
  /** How a `[Sn]` marker is drawn: a chip that links to its passage. */
  readonly marker: (marker: number, key: string) => ReactNode;
}

function inline(nodes: readonly Inline[], marker: Props['marker'], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}.${String(index)}`;
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'strong':
        return <strong key={key}>{inline(node.children, marker, key)}</strong>;
      case 'em':
        return <em key={key}>{inline(node.children, marker, key)}</em>;
      case 'code':
        return <code key={key}>{node.text}</code>;
      case 'marker':
        return marker(node.marker, key);
    }
  });
}

/**
 * An answer drawn from `parseAnswer`'s tree with plain elements. Every string
 * is a React text child, so nothing the model wrote can become markup.
 */
export function AnswerText({ text, marker }: Props) {
  return (
    <>
      {parseAnswer(text).map((block, index) => {
        const key = String(index);
        if (block.kind === 'paragraph')
          return <p key={key}>{inline(block.children, marker, key)}</p>;
        const items = block.items.map((item, i) => (
          <li key={i}>{inline(item, marker, `${key}.${String(i)}`)}</li>
        ));
        return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
      })}
    </>
  );
}
