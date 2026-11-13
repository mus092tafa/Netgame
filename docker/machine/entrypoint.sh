#!/bin/bash
# Starts the services listed in $SERVICES, applies $DROP_PORTS firewall rules, then idles.
set -u
for s in ${SERVICES:-}; do
  case "$s" in
    postgres)
      # First boot: open Postgres to the network and create the game's database user.
      conf=/etc/postgresql/15/main
      if ! grep -q netgame "$conf/pg_hba.conf"; then
        echo "listen_addresses = '*'" >> "$conf/postgresql.conf"
        echo "host all all 0.0.0.0/0 trust # netgame" >> "$conf/pg_hba.conf"
      fi
      pg_ctlcluster 15 main start
      su postgres -c "psql -qc \"CREATE ROLE app LOGIN\"" 2>/dev/null
      su postgres -c "createdb -O app app" 2>/dev/null
      ;;
    *) /usr/local/bin/svc start "$s" ;;
  esac
done
for p in ${DROP_PORTS:-}; do
  iptables -A INPUT -p tcp --dport "$p" -j DROP 2>/dev/null || echo "warning: could not block port $p (needs NET_ADMIN)"
done
echo "ready: ${SERVICES:-no services}"
exec sleep infinity
