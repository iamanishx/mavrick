#!/usr/bin/env bash
curl -X POST http://localhost:3001/run \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/iamanishx/proxy-server",
    "issueUrl": "https://github.com/iamanishx/proxy-server/issues/1",
    "description": "Fix the README.md",
    "token": "'"${GITHUB_TOKEN:-}"'"
  }'
