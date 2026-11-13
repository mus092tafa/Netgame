import { useEffect, useRef } from 'react';
import type { LogRow } from '../useNetwork.ts';

/** Wireshark-style list of everything the map has seen, newest at the bottom. */
export function ConnectionLog({ rows, start }: { rows: LogRow[]; start: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [rows]);
  return (
    <div className="panel log">
      <div className="panel-title">
        CONNECTION LOG
        <span className="log-keys">
          <span className="k cat-ssh">SSH</span>
          <span className="k cat-http">HTTP</span>
          <span className="k cat-db">DB</span>
          <span className="k cat-dns">DNS</span>
          <span className="k cat-icmp">ICMP</span>
          <span className="k cat-fail">FAILED</span>
        </span>
      </div>
      <div className="log-body" ref={ref}>
        <table>
          <thead>
            <tr>
              <th>NO.</th>
              <th>TIME</th>
              <th>SOURCE</th>
              <th>DESTINATION</th>
              <th>PROTOCOL</th>
              <th>INFO</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className={`cat-${r.category}`}>
                <td><span className="no">{i + 1}</span></td>
                <td>{((r.t - start) / 1000).toFixed(1)}s</td>
                <td>{r.src}</td>
                <td>{r.dst}</td>
                <td className="proto">{r.proto}</td>
                <td>{r.info}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="muted">Nothing yet. Run a command in the terminal and watch the map.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
