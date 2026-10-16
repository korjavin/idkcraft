#!/bin/sh
# idkcraft-6x7.27: print the cached BEFORE component line for this branch's base (README "Rig speed").
exec node "$(dirname "$0")/castle-before.js" "$@"
