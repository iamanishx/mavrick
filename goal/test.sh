#!/usr/bin/env bash

# Scratch Mode
curl -X POST http://localhost:3001/run \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/iamanishx/proxy-server",
    "description": "Fix formatting in README.md",
    "token": "'"${GITHUB_TOKEN:-}"'"
  }'

# Existing PR Mode
curl -X POST http://localhost:3001/run \
  -H "Content-Type: application/json" \
  -d '{
    "prUrl": "https://github.com/iamanishx/proxy-server/pull/1",
    "description": "Add new tests for proxy configurations",
    "token": "'"${GITHUB_TOKEN:-}"'"
  }'