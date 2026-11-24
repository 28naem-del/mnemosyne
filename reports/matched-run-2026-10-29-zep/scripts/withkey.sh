#!/bin/bash
# Loads Zep keys into this process env from the 0600 file; never echoes them.
set -a; . "$HOME/.openclaw/secrets/zep.env"; set +a
exec "$@"
