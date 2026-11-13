import type { ServiceCategory } from './protocol.ts';

interface ServiceDef {
  name: string;
  category: ServiceCategory;
}

/** Built-in port → service table (destination port). */
export const PORT_TABLE: Record<number, ServiceDef> = {
  20: { name: 'FTP-data', category: 'unknown' },
  21: { name: 'FTP', category: 'unknown' },
  22: { name: 'SSH', category: 'ssh' },
  23: { name: 'Telnet', category: 'unknown' },
  25: { name: 'SMTP', category: 'unknown' },
  53: { name: 'DNS', category: 'dns' },
  80: { name: 'HTTP', category: 'http' },
  110: { name: 'POP3', category: 'unknown' },
  143: { name: 'IMAP', category: 'unknown' },
  443: { name: 'HTTPS', category: 'https' },
  1433: { name: 'MSSQL', category: 'db' },
  2222: { name: 'SSH', category: 'ssh' },
  3000: { name: 'HTTP', category: 'http' },
  3306: { name: 'MySQL', category: 'db' },
  5432: { name: 'PostgreSQL', category: 'db' },
  6379: { name: 'Redis', category: 'db' },
  8000: { name: 'HTTP', category: 'http' },
  8443: { name: 'HTTPS', category: 'https' },
  9200: { name: 'Elasticsearch', category: 'db' },
  27017: { name: 'MongoDB', category: 'db' },
};

/** Process name → service, used when the port isn't in the table (e.g. nginx on :8080). */
const PROCESS_TABLE: Record<string, ServiceDef> = {
  sshd: { name: 'SSH', category: 'ssh' },
  nginx: { name: 'HTTP', category: 'http' },
  apache2: { name: 'HTTP', category: 'http' },
  httpd: { name: 'HTTP', category: 'http' },
  postgres: { name: 'PostgreSQL', category: 'db' },
  mysqld: { name: 'MySQL', category: 'db' },
  'redis-server': { name: 'Redis', category: 'db' },
  dnsmasq: { name: 'DNS', category: 'dns' },
  named: { name: 'DNS', category: 'dns' },
};

export function lookupService(port: number, transport: 'tcp' | 'udp' = 'tcp', process?: string): ServiceDef {
  const byPort = PORT_TABLE[port];
  if (byPort) return byPort;
  if (process && PROCESS_TABLE[process]) return PROCESS_TABLE[process];
  return { name: transport.toUpperCase(), category: 'unknown' };
}

export const CATEGORY_LABEL: Record<ServiceCategory, string> = {
  ssh: 'SSH',
  http: 'HTTP',
  https: 'HTTPS',
  db: 'Database',
  dns: 'DNS',
  icmp: 'Ping (ICMP)',
  unknown: 'Other / unknown',
};
