# tap2cal-mcp

An [MCP](https://modelcontextprotocol.io) server for [Tap2Cal](https://tap2cal.com).

Lets an AI assistant turn an event into a **shareable add-to-calendar link**.
Anyone who opens the link saves the event to Google Calendar, Apple Calendar,
Outlook or any other calendar with one tap, no app and no account needed.

```
You:    Make a calendar link for our summer party, July 5, 6 to 10 pm in
        Vienna, with RSVPs, and use the poster on my desktop as flyer.
Claude: [create_event, then set_flyer]
        Here is your link: https://tap2cal.com/summer-party
```

The assistant can do everything you can do in the app: create, change and
delete events, choose the link, disable earlier links, add a flyer and read
who accepted or declined.

## Setup

Create a free account at [tap2cal.com/app](https://tap2cal.com/app/login), open
[your account](https://tap2cal.com/app/account) and create a key under
"API and AI assistants". Events created with it appear under My events.

### Claude Code

```bash
claude mcp add tap2cal -e TAP2CAL_API_KEY=t2c_YOUR_KEY -- npx -y tap2cal-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tap2cal": {
      "command": "npx",
      "args": ["-y", "tap2cal-mcp"],
      "env": { "TAP2CAL_API_KEY": "t2c_YOUR_KEY" }
    }
  }
}
```

### Cursor, Zed and other MCP clients

Same shape: command `npx`, args `["-y", "tap2cal-mcp"]`, and `TAP2CAL_API_KEY`
in the environment.

### Without installing anything

Clients that support remote servers can connect to the hosted server instead:
`https://mcp.tap2cal.com` with the header `Authorization: Bearer t2c_YOUR_KEY`.
This package adds one thing the hosted server can't do: `set_flyer` can read
an image file from your computer.

## Tools

Wherever an event is needed, its id, any of its links or the full URL works.

| Tool | What it does |
|------|--------------|
| `create_event` | Creates an event and returns its link. Optional own link via `slug` |
| `list_my_events` | Lists your events with page views, calendar clicks and RSVP counts |
| `get_event` | Shows one event with all details and its earlier links |
| `update_event` | Changes only the fields you pass, including the link (`slug`) |
| `disable_old_link` | Turns off an earlier link after the link was changed |
| `list_rsvps` | Lists who accepted or declined, with the people they bring |
| `add_rsvp` | Adds an answer that came in another way, for example in a chat |
| `update_rsvp` | Corrects an answer, for example when both partners of a couple brought each other as a guest |
| `delete_rsvp` | Removes an answer, for example a duplicate |
| `set_flyer` | Adds a flyer from a file on this computer or an image URL |
| `remove_flyer` | Removes the flyer |
| `delete_event` | Deletes an event and all its links. Can't be undone |

Event pages are public to anyone with the link and are deleted 90 days after
the event ends.

## Configuration

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `TAP2CAL_API_KEY` | yes | (none) | Your API key, starts with `t2c_` |
| `TAP2CAL_API_URL` | no | `https://api.tap2cal.com/v1` | Only for testing |
| `TAP2CAL_TIMEOUT_MS` | no | `30000` | Request timeout |

The key is never a tool argument and never part of a tool result, so it does
not end up in the conversation.

## Limits

Up to 50 events and 20 images per account per day. Errors come back with an
explanation the assistant can pass on, for example when a link is already taken.

## Links

- [Developer documentation](https://tap2cal.com/developers/)
- [OpenAPI description](https://tap2cal.com/openapi.json)

## License

MIT
