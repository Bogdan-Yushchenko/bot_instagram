# Instagram DM Bot

An automated bot for handling Instagram Direct messages. Uses Playwright (headless Chromium) to poll the inbox, replies with OpenAI GPT, maintains conversation history, and builds psychological profiles of users for platform analytics.

---

## Requirements

- **Node.js** 18 or higher
- **npm**
- An Instagram account
- An OpenAI API key

---

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browser
npx playwright install chromium

# 3. Create your .env file (see Configuration section)
```

---

## File Structure

```
bot_instagram/
├── bot.js                  # Main bot logic
├── .env                    # Configuration — never committed to git
├── session.json            # Saved Instagram session — never committed to git
├── bot_state.json          # Conversation history and statuses — never committed to git
├── user_profiles.json      # Psychological profiles (owner-only) — never committed to git
├── package.json
└── .gitignore
```

---

## Configuration (.env)

All settings are stored in the `.env` file in the project root.

### Required

| Variable | Description | Example |
|---|---|---|
| `IG_USERNAME` | Instagram account username | `myaccount` |
| `IG_PASSWORD` | Instagram account password | `MyPassword123` |
| `OPENAI_API_KEY` | OpenAI API key | `sk-proj-...` |

### Optional

| Variable | Default | Description |
|---|---|---|
| `CHECK_INTERVAL` | `15000` | Inbox polling interval in milliseconds. `15000` = every 15 seconds |
| `REQUESTS_INTERVAL` | `120000` | Message requests polling interval in milliseconds. `120000` = every 2 minutes |
| `OPENAI_GREETING_MESSAGE` | _(not set)_ | First message the bot sends to every new contact. If not set, the bot does not initiate conversation |
| `OPENAI_SYSTEM_PROMPT` | _(built-in prompt)_ | GPT system instruction defining the bot's role and behavior. Wrap in double quotes; use `\n` for line breaks |

### Example .env

```env
IG_USERNAME=myinstagram
IG_PASSWORD=MyPassword123
CHECK_INTERVAL=15000
REQUESTS_INTERVAL=120000

OPENAI_API_KEY=sk-proj-XXXXXXXXXXXXXXXXXX

OPENAI_GREETING_MESSAGE=Hi! I'm an assistant from an interactive therapy platform. I'm here to help — feel free to ask me anything!

OPENAI_SYSTEM_PROMPT="You are an empathetic mental wellness assistant. Always reply in the same language the user writes in. Be warm, supportive, and human."
```

---

## Running the Bot

```bash
node bot.js
```

On the **first launch**, a browser window will open with Instagram — log in manually. The session is saved to `session.json` and subsequent starts will skip the login step automatically.

### Stopping

Press `Ctrl+C` in the terminal. The bot will save the session and close the browser cleanly.

### Killing stale processes

If multiple browser windows appear, multiple `node.exe` processes are running simultaneously:

```powershell
# Stop all Node processes
taskkill /F /IM node.exe

# Then start one
node bot.js
```

---

## How It Works

### Polling Loop

1. Every `CHECK_INTERVAL` ms — opens the inbox page
2. Finds threads with unread indicators (bold font in the sidebar)
3. Opens each thread and processes the latest user message
4. Every `REQUESTS_INTERVAL` ms — additionally checks the "Message Requests" section

### Message Processing Flow

```
RECEIVED → PROCESSING → GPT_REQ → GPT_OK → IG_SEND → DONE
                                          ↘ ERROR → retry after 60s (max 3 attempts)
                                                   → SKIP after max retries
```

A message is only marked as processed **after** it is successfully sent. If OpenAI fails or Instagram send fails, the message is retried automatically.

### Greeting

If `OPENAI_GREETING_MESSAGE` is set, the bot checks whether that exact message is already visible in the chat. If not — it sends it first. This happens only **once per contact** and the flag is stored in `bot_state.json`.

### Psychological Profiles

After each successful reply, the bot makes a separate GPT call to analyze the user's messages and update their profile in `user_profiles.json`. The profile includes:

1. Emotional state
2. Personality traits
3. Communication style
4. Main topics and requests
5. Probable needs
6. Risk level — suicidal ideation / crisis: **low / medium / high**

This file is stored locally and **never committed to git**.

---

## Log Format

```
[HH:MM:SS.mmm] [LEVEL     ] [THREAD_ID] message
```

| Level | Meaning |
|---|---|
| `STARTUP` | Bot startup, data loading |
| `QUEUE` | Inbox check, unread threads found |
| `QUEUED` | Opening a specific thread |
| `GREET` | Sending greeting message |
| `RECEIVED` | New message from user detected |
| `PROCESSING` | Starting to process the message |
| `GPT_REQ` | Request sent to OpenAI |
| `GPT_OK` | OpenAI response received |
| `IG_SEND` | Typing and sending reply in Instagram |
| `DONE` | Message processed successfully |
| `PROFILE` | User psychological profile updated |
| `ERROR` | Failure — will be retried |
| `RETRY` | Retrying after a previous error |
| `BACKOFF` | Waiting before next retry |
| `SKIP` | Max retries reached — message skipped permanently |
| `ACCEPT` | Message request accepted |

### Example Output

```
[12:09:36.756] [STARTUP   ] [-] loaded 4 threads (0 ERROR), 36 known replies
[12:09:36.765] [STARTUP   ] [-] session valid, skipping login
[12:23:30.812] [QUEUE     ] [-] inbox: 1 unread, clicking 1 thread(s)
[12:23:32.673] [QUEUED    ] [18030845642602644] opening thread
[12:23:32.691] [GREET     ] [18030845642602644] sending greeting...
[12:23:34.100] [RECEIVED  ] [18030845642602644] new message: "Hello"
[12:23:34.102] [PROCESSING] [18030845642602644] started
[12:23:34.103] [GPT_REQ   ] [18030845642602644] sending to OpenAI...
[12:23:35.800] [GPT_OK    ] [18030845642602644] reply ready: "Hi! How are you feeling today?"
[12:23:35.801] [IG_SEND   ] [18030845642602644] typing reply...
[12:23:37.200] [DONE      ] [18030845642602644] "Hello" → "Hi! How are you feeling today?"
[12:23:41.500] [PROFILE   ] [18030845642602644] updated (5 user msgs)
```

---

## Data Files

### bot_state.json

Stores the conversation state for every thread and a list of known bot replies (used to detect outgoing messages by content). Loaded on startup, saved after every action.

```json
{
  "threads": {
    "/direct/t/123.../": {
      "lastUserMsg": "last user message that was replied to",
      "lastBotMsg": "last bot reply that was sent",
      "greetingSent": true,
      "pendingUserMsg": null,
      "status": "DONE",
      "retries": 0,
      "retryAt": null
    }
  },
  "replies": ["known reply 1", "known reply 2"]
}
```

**Status values:**
- `DONE` — message successfully processed
- `ERROR` — last attempt failed, will retry
- `PROCESSING` — in progress (reset to `ERROR` on restart for crash recovery)

### user_profiles.json

Psychological profiles built from user conversations. **Owner-only — not committed to git.**

```json
{
  "/direct/t/123.../": {
    "lastUpdated": "2026-06-13T10:00:00.000Z",
    "messageCount": 12,
    "fullProfile": "1) Emotional state: anxious...\n2) Personality traits: ..."
  }
}
```

### session.json

Saved browser session (cookies, localStorage). Allows the bot to skip login on subsequent starts. **Not committed to git.**

---

## Troubleshooting

### Bot doesn't log in
- Check `IG_USERNAME` and `IG_PASSWORD` in `.env`
- Delete `session.json` and restart — log in manually in the browser that opens

### Bot doesn't reply to messages
- Check `OPENAI_API_KEY` — the account may be out of credits
- Look for `[ERROR]` lines in the log for the specific reason
- After 3 failed attempts the message is `[SKIP]`-ped permanently

### Multiple browser windows open
- Multiple `node.exe` processes are running at the same time
- Kill all: `taskkill /F /IM node.exe` in PowerShell
- Start one: `node bot.js`

### Session expired
- Log will show `session expired`
- Delete `session.json`, restart, and log in manually

---

## Security

The following files are listed in `.gitignore` and will **never be committed to git**:

| File | Contains |
|---|---|
| `.env` | Instagram credentials, OpenAI API key |
| `session.json` | Active Instagram session (equivalent to being logged in) |
| `bot_state.json` | Conversation history |
| `user_profiles.json` | Private user psychological data |

Never share these files with third parties.
