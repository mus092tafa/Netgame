# Sourced by every interactive bash (from /etc/bash.bashrc), including shells reached over ssh.
# Tells the game server what happens in the terminal by printing invisible OSC escape sequences:
#   ESC ] 7777 ; netgame ; cmd    ; <host> ; <base64 command line> BEL   before a command runs
#   ESC ] 7777 ; netgame ; done   ; <host> ; <exit code>           BEL   when it finished
#   ESC ] 7777 ; netgame ; prompt ; <host> ; <user>                BEL   at every prompt
# The server strips them before the terminal shows anything. They pass through ssh untouched,
# which is how the server knows which machine each command ran on.
[ -n "${BASH_VERSION:-}" ] || return 0
[ -n "${__ng_hooked:-}" ] && return 0
__ng_hooked=1
__ng_ready=0
__ng_user=$(id -un) # $USER isn't set under `docker exec`

__ng_emit() { printf '\033]7777;netgame;%s;%s;%s\007' "$1" "$HOSTNAME" "$2"; }

__ng_preexec() {
  [ "$__ng_ready" = 1 ] || return
  case "$BASH_COMMAND" in __ng_*) return ;; esac
  __ng_ready=0
  local line
  line=$(HISTTIMEFORMAT= builtin history 1)
  line=${line#"${line%%[![:space:]]*}"} # history number and its padding
  line=${line#*[[:space:]]}
  line=${line#"${line%%[![:space:]]*}"}
  __ng_emit cmd "$(printf '%s' "$line" | base64 -w0)"
}

__ng_precmd() {
  local ec=$?
  [ "$__ng_ready" = 0 ] && [ -n "${__ng_started:-}" ] && __ng_emit done "$ec"
  __ng_started=1
  __ng_emit prompt "$__ng_user"
  # A command typed with a leading space must still reach history, or `history 1` reads the wrong one.
  HISTCONTROL=${HISTCONTROL//ignoreboth/ignoredups}
  HISTCONTROL=${HISTCONTROL//ignorespace/}
  __ng_ready=1
  return $ec
}

PROMPT_COMMAND=__ng_precmd
trap __ng_preexec DEBUG
