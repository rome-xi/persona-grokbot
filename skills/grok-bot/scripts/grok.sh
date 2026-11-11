#!/usr/bin/env bash
# Persona's gate proxy adds credentials; this command never reads or prints tokens.
set -euo pipefail
fail() { printf 'grok: %s\n' "$*" >&2; exit 2; }
[[ $# -ge 2 && $# -le 3 ]] || fail 'usage: grok METHOD PATH [JSON]; no files or extra curl arguments'
BASE=${GROKBOT_API:-}
[[ -n "$BASE" ]] || { printf 'grok: Grok Bot 插件未提供接口，请检查插件是否开启并已登录。\n' >&2; exit 3; }
BASE=${BASE%/}
method=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
path=$2
body=${3-}
query=''
if [[ "$path" == *\?* ]]; then
  query=${path#*\?}
  path=${path%%\?*}
fi
# Only the list or a Grok Bot message/read endpoint; no alternate URLs, dot segments, encoded paths, or curl options.
if [[ "$method" == GET && "$path" == /sessions ]]; then
  [[ $# == 2 && -z "$query" ]] || fail 'session list takes no body or query'
  path='/sessions?source=grokbot&provider=grok_bot'
else
  [[ "$path" =~ ^/sessions/(grokbot:[A-Za-z0-9_-]+/[A-Za-z0-9_-]*)/(messages|read)$ ]] || fail 'expected an unencoded grokbot session id and /messages or /read'
  id=${BASH_REMATCH[1]}
  action=${BASH_REMATCH[2]}
  if [[ "$method" == GET && "$action" == messages ]]; then
    [[ $# == 2 ]] || fail 'read takes no body'
    [[ -z "$query" || "$query" =~ ^(limit=[0-9]+|cursor=[0-9]+)(\&(limit=[0-9]+|cursor=[0-9]+))*$ ]] || fail 'only numeric limit/cursor queries are supported'
  elif [[ "$method" == POST && "$action" == messages ]]; then
    [[ $# == 3 && -z "$query" ]] || fail 'send requires inline JSON, without query'
    [[ "$body" != *'$'* ]] || fail 'spell dollar amounts in words; this hub cannot bind a confirmation containing a dollar sign'
    bytes=$(LC_ALL=C printf '%s' "$body" | wc -c)
    [[ "$bytes" -le 1800 ]] || fail 'JSON exceeds 1800 bytes; split into separately confirmed messages'
    printf '%s' "$body" | jq -e 'type == "object" and (keys == ["clientId","text"]) and (.clientId | type == "string" and test("^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$")) and (.text | type == "string" and test("\\S"))' >/dev/null 2>&1 || fail 'send requires only clientId (stable UUID) and nonempty text'
  elif [[ "$method" == POST && "$action" == read ]]; then
    [[ $# == 2 && -z "$query" ]] || fail 'mark-read takes no body or query'
    body='{}'
  else
    fail 'unsupported operation'
  fi
  # Safe restricted ID alphabet: only colon and slash need percent encoding.
  id=${id//:/%3A}
  id=${id//\//%2F}
  path="/sessions/$id/$action"
  [[ -z "$query" ]] || path="$path?$query"
fi
args=(-sS --fail-with-body -m 60 -X "$method" -H 'accept: application/json')
[[ -z "$body" ]] || args+=(-H 'content-type: application/json' --data-raw "$body")
# No redirects or retries: a new logical send must never happen implicitly.
exec curl "${args[@]}" "$BASE$path"
