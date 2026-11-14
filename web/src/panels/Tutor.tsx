import { Fragment, useEffect, useRef } from 'react';
import type { TutorMsg } from '../useNetwork.ts';

function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/).map((part, j) => {
        if (part.startsWith('**')) return <b key={j}>{part.slice(2, -2)}</b>;
        if (part.startsWith('`')) return <code key={j}>{part.slice(1, -1)}</code>;
        if (part.startsWith('*') && part.length > 2) return <i key={j}>{part.slice(1, -1)}</i>;
        return <Fragment key={j}>{part}</Fragment>;
      })}
    </>
  );
}

/** Tiny markdown: **bold**, `code`, *italic*, paragraphs, and "- " lists. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\n+/).map((para, i) => {
        const lines = para.split('\n');
        if (lines.every((l) => l.startsWith('- ')))
          return (
            <ul key={i}>
              {lines.map((l, j) => <li key={j}><Inline text={l.slice(2)} /></li>)}
            </ul>
          );
        return <p key={i}><Inline text={para} /></p>;
      })}
    </>
  );
}

export function Tutor({ messages }: { messages: TutorMsg[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);
  return (
    <div className="panel tutor">
      <div className="panel-title">TUTOR</div>
      <div className="tutor-body" ref={ref}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.from}`}>
            <Rich text={m.text} />
          </div>
        ))}
      </div>
    </div>
  );
}
