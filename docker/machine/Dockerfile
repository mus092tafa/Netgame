# One image for every machine in the game. What runs is chosen by $SERVICES (see entrypoint.sh).
FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      iproute2 procps iputils-ping netcat-openbsd telnet curl wget ca-certificates dnsutils \
      openssh-server openssh-client \
      nginx-light postgresql postgresql-client dnsmasq iptables sudo less \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/nginx/sites-enabled/default

# Player account. All machines share one SSH key so hops (laptop → web-01 → db-01) need no password.
# Fine for a learning sandbox; never do this on real servers.
RUN useradd -m -s /bin/bash dev \
 && mkdir -p /home/dev/.ssh /run/sshd \
 && ssh-keygen -q -t ed25519 -N '' -f /home/dev/.ssh/id_ed25519 -C netgame \
 && cp /home/dev/.ssh/id_ed25519.pub /home/dev/.ssh/authorized_keys \
 && printf 'Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n' > /home/dev/.ssh/config \
 && chown -R dev:dev /home/dev/.ssh && chmod 700 /home/dev/.ssh && chmod 600 /home/dev/.ssh/* \
 && printf 'PasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/netgame.conf \
 && echo 'dev ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/sbin/service, /usr/local/bin/svc' > /etc/sudoers.d/dev

COPY nginx.conf /etc/nginx/conf.d/netgame.conf
COPY entrypoint.sh svc /usr/local/bin/
# Shell hook that reports each command to the game server (see netgame-shell.sh).
COPY netgame-shell.sh /etc/netgame-shell.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/svc \
 && ln -sf /usr/local/bin/svc /usr/local/bin/systemctl \
 && echo '. /etc/netgame-shell.sh' >> /etc/bash.bashrc

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
