// Which level goals a connection or an event reaches. Shared so the server tests can check levels.
import type { MapEdge, MapEvent, TargetConnection } from './protocol.ts';

/** Goals a working connection reaches. */
export function edgeGoals(targets: TargetConnection[], e: MapEdge): number[] {
  return targets
    .map((t, i) => ((t.kind ?? 'connect') === 'connect' && t.from === e.client.machine && t.to === e.server.machine && t.port === e.server.port ? i : -1))
    .filter((i) => i >= 0);
}

/** Goals a ping or a failed attempt reaches. */
export function eventGoals(targets: TargetConnection[], ev: MapEvent): number[] {
  return targets
    .map((t, i) => {
      if (t.from !== ev.from) return -1;
      if (t.kind === 'ping') return ev.kind === 'ping' && ev.ok && ev.to === t.to ? i : -1;
      if (t.kind === 'refused' || t.kind === 'timeout')
        return ev.kind === 'failed' && ev.reason === t.kind && ev.to === t.to && ev.port === t.port ? i : -1;
      return -1;
    })
    .filter((i) => i >= 0);
}
