#!/usr/bin/env bash
#
# A/B the residential-proxy cost controls on one live Zoom meeting.
#
#   ./proxy-ab-test.sh A 'https://us05web.zoom.us/j/123?pwd=xyz'   # old behaviour (baseline)
#   ./proxy-ab-test.sh B '<same url>'                             # watchdog only
#   ./proxy-ab-test.sh C '<same url>'                             # shipped default
#   ./proxy-ab-test.sh report                                     # compare the three
#   ./proxy-ab-test.sh clean                                      # un-wedge .env
#
# Run them against the SAME meeting, back to back, each for a similar length of
# time. Leave the meeting running throughout. Ctrl-C when you've seen enough —
# the stats are written on shutdown, so let the bot exit cleanly if you can.
#
# .env is swapped per run and restored on exit, including on Ctrl-C.

set -uo pipefail
cd "$(dirname "$0")"

RUN="${1:-}"; URL="${2:-}"
LOGDIR=./proxy-test-logs
mkdir -p "$LOGDIR"

c_red=$'\033[0;31m'; c_grn=$'\033[0;32m'; c_ylw=$'\033[1;33m'; c_blu=$'\033[0;34m'; c_off=$'\033[0m'
say()  { echo -e "${c_blu}▶ $*${c_off}"; }
ok()   { echo -e "${c_grn}✔ $*${c_off}"; }
warn() { echo -e "${c_ylw}⚠ $*${c_off}"; }
die()  { echo -e "${c_red}FAIL: $*${c_off}" >&2; exit 1; }

# ---------------------------------------------------------------- preflight --
preflight() {
  [ -f .env ] || die ".env not found"
  grep -q '^RESIDENTIAL_PROXY_TEMPLATE=' .env \
    || die "RESIDENTIAL_PROXY_TEMPLATE missing from .env — the proxy will not start and the run proves nothing"
  local v; v=$(grep '^RESIDENTIAL_PROXY_TEMPLATE=' .env | cut -d= -f2-)
  case "$v" in
    \"*|\'*) die "RESIDENTIAL_PROXY_TEMPLATE is quoted. docker --env-file keeps quotes literally, so the URL won't parse. Remove them." ;;
    http://*) warn "template uses http:// — prod uses https:// on port 10000 (the TLS endpoint). Expect 'Upstream proxy unreachable'." ;;
  esac
  grep -q '{SESSION}' .env || warn "template has no {SESSION} — every bot will share one exit IP"
  command -v docker >/dev/null || die "docker not found"
  docker images | grep -q meet-teams-bot || { say "image not built yet — building"; ./run_bot.sh build || die "build failed"; }
  local img src
  img=$(docker image inspect -f '{{.Created}}' meet-teams-bot:latest 2>/dev/null | cut -c1-19)
  src=$(find src Dockerfile -newermt "${img:-1970-01-01T00:00:00}" -type f 2>/dev/null | head -3)
  if [ -n "$src" ]; then
    warn "image is OLDER than these source files — you are testing stale code:"
    echo "$src" | sed 's/^/    /'
    warn "run ./run_bot.sh build first"
    read -r -p "  continue anyway? [y/N] " a; [ "$a" = y ] || exit 1
  fi
}

# ------------------------------------------------------------------- runner --
KNOB_KEYS='^(ZOOM_PROXY_HOSTS|PROXY_CLOSE_ON_DIRECT|PROXY_MAX_HOST_BYTES|PROXY_MAX_CONN_BYTES|PROXY_MAX_BOT_BYTES)='
strip_knobs() { grep -vE "$KNOB_KEYS" .env; }
knobs_for() {
  case "$1" in
    A) printf '%s\n' 'ZOOM_PROXY_HOSTS=.zoom.us' 'PROXY_CLOSE_ON_DIRECT=false' 'PROXY_MAX_HOST_BYTES=0' 'PROXY_MAX_BOT_BYTES=0' ;;
    B) printf '%s\n' 'ZOOM_PROXY_HOSTS=.zoom.us' ;;
    C) : ;;                       # shipped defaults, nothing to set
  esac
}
label_for() {
  case "$1" in
    A) echo "BASELINE — the old blanket rule, all three layers off" ;;
    B) echo "WATCHDOG ONLY — blanket list, layers 2+3 on (watch for ✂️)" ;;
    C) echo "SHIPPED DEFAULT — narrow list + close-at-admission + watchdog" ;;
  esac
}

do_run() {
  local tag="$1" url="$2"
  [ -n "$url" ] || die "give me the Zoom URL:  ./proxy-ab-test.sh $tag 'https://…zoom.us/j/…'"
  preflight

  local base; base=$(mktemp)
  strip_knobs > "$base"           # base is .env WITHOUT any knob lines, always
  restore() { cp "$base" .env; rm -f "$base"; echo; say ".env restored (knobs removed)"; }
  trap restore EXIT INT TERM

  cp "$base" .env
  knobs_for "$tag" >> .env

  local log="$LOGDIR/run-$tag.log"
  echo
  say "RUN $tag — $(label_for "$tag")"
  knobs_for "$tag" | sed 's/^/    /' || true
  [ "$tag" = C ] && echo "    (no overrides — code defaults)"
  say "logging to $log"
  echo

  ./run_bot.sh run bot.config.zoom.json meeting_platform=zoom "meeting_url=$url" 2>&1 | tee "$log"
  echo
  summarise "$tag"
}

# ----------------------------------------------------------------- reporting --
summarise() {
  local tag log
  tag="$1"
  log="$LOGDIR/run-$tag.log"
  [ -f "$log" ] || { warn "no log for run $tag"; return; }
  echo "──────────────────────────────────────────────────────────────"
  echo "RUN $tag — $(label_for "$tag")"

  if grep -q "Exit IP:" "$log"; then
    ok "proxy was live: $(grep -m1 'Exit IP:' "$log" | sed 's/.*Exit IP: //')"
  else
    warn "NO EXIT IP IN THE LOG — the proxy never came up, this run proves nothing"
    grep -m2 -E "skipping proxy|Upstream proxy unreachable|Failed to start" "$log" | sed 's/^/    /'
    echo "──────────────────────────────────────────────────────────────"
    return
  fi

  if grep -q "onJoinSuccess called" "$log"; then ok "bot was admitted to the meeting"
  else warn "bot never got in — bytes below cover the join attempt only"; fi

  local policy
  policy=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -m1 "⚙️  policy" | sed -E 's/^.*policy \| //')
  if [ -z "$policy" ]; then
    warn "no policy line — image predates the config logging; rebuild with ./run_bot.sh build"
  else
    echo "  policy: $policy"
    case "$tag" in
      A|B) grep -q "SUFFIX=" <<<"$policy" || warn "run $tag was supposed to use the .zoom.us SUFFIX list — it did not" ;;
      C)   if grep -q "SUFFIX=" <<<"$policy"; then
             warn "RUN C USED THE BLANKET LIST — this is not the shipped config."
             warn "  a stale .env baked into the image overrides vars the runtime file omits."
             warn "  fix: .env is now in .dockerignore — ./run_bot.sh build, then re-run C."
           fi ;;
    esac
  fi

  local dem; dem=$(grep -c "routing that host direct from now on" "$log" 2>/dev/null || true); dem=${dem:-0}
  [ "$dem" -gt 0 ] && ok "watchdog demoted $dem host(s) mid-run:" && \
    grep -oE "✂️  [a-z0-9.-]+ passed" "$log" | awk '{print "    "$2}' | sort -u

  echo
  echo "  final residential usage (shutdown stats, NOT the join-complete line):"
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" \
    | awk '/Final stats at proxy shutdown/{f=1} f' \
    | sed -E 's/^.*toggle-proxy:[0-9]+: *//' \
    | grep -vE '^\s*$' | head -25 | sed 's/^/    /' 
  grep -q "Final stats at proxy shutdown" "$log" || \
    warn "  no shutdown stats — the bot was killed before cleanup ran. Let it exit cleanly next time."
  echo "──────────────────────────────────────────────────────────────"
}

report() {
  echo
  for t in A B C; do summarise "$t"; done
  echo
  say "headline: compare the 'total (Decodo billed)' line across the three runs."
  say "expect roughly  A ≈ 13 MB   B ≈ a few MB   C ≈ 0.2 MB  for a similar meeting length."
  say "if C joined as reliably as A across a few runs, the change is safe to ship."
}

case "$RUN" in
  A|B|C) do_run "$RUN" "$URL" ;;
  report) report ;;
  clean)
    if grep -qE "$KNOB_KEYS" .env; then
      t=$(mktemp); strip_knobs > "$t"; cat "$t" > .env; rm -f "$t"
      ok "removed leftover knob lines from .env"
    else ok ".env is clean"; fi ;;
  *) sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
