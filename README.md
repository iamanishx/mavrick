# Mavrick Test Bot

A GitHub App bot that automatically generates integration tests for Pull Requests using Vercel AI SDK.

## Features
- Listens for comments on PRs mentioning `@mavrick-bot`.
- Analyzes changed files in the PR.
- Generates integration tests (Jest/Vitest) using OpenAI (GPT-4o).
- Creates a new branch and opens a PR with the generated tests targeting the original PR.

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Environment Variables**:
    Copy `.env.example` to `.env` and fill in:
    - `APP_ID`: Your GitHub App ID.
    - `PRIVATE_KEY`: Your GitHub App Private Key.
    - `WEBHOOK_SECRET`: Your GitHub App Webhook Secret.
    - `OPENAI_API_KEY`: Your OpenAI API Key.

3.  **Run**:
    ```bash
    npm start
    ```

## Development

- Run `npm run dev` to start with hot-reload.
- Use `smee-client` to proxy webhooks to localhost if developing locally.

## Usage

1.  Install the app on your repository.
2.  Open a Pull Request.
3.  Comment `@mavrick-bot` on the PR.
4.  The bot will reply, generate tests, and link the new PR containing the tests.
