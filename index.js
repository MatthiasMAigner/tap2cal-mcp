#!/usr/bin/env node
/**
 * Tap2Cal MCP server.
 *
 * Lets an assistant turn an event into a shareable add-to-calendar link and
 * manage it afterwards: change it, change its link, read RSVPs, add a flyer.
 * It talks to the Tap2Cal REST API with the user's API key.
 *
 * Configuration:
 *   TAP2CAL_API_KEY=t2c_...   from https://tap2cal.com/app/account
 *
 * The key never goes into a tool argument or a tool result, so it does not
 * travel through the transcript.
 *
 * stdio note: stdout is the protocol channel. Everything diagnostic goes to
 * stderr, or the client sees corrupted frames.
 */
import { readFile, stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const KEY = process.env.TAP2CAL_API_KEY;
const BASE = (process.env.TAP2CAL_API_URL || "https://api.tap2cal.com/v1").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.TAP2CAL_TIMEOUT_MS || 30_000);
const FLYER_MAX_BYTES = 8 * 1024 * 1024;
const LANGUAGES = ["en", "de", "es", "fr", "it", "pt"];

if (!KEY) {
  console.error(
    "tap2cal-mcp: TAP2CAL_API_KEY is not set.\n" +
      "Create a free account at https://tap2cal.com/app/login, open your account,\n" +
      "create a key under \"API and AI assistants\" and set TAP2CAL_API_KEY=t2c_...",
  );
  process.exit(1);
}
let parsed;
try {
  parsed = new URL(BASE);
} catch {
  console.error(`tap2cal-mcp: TAP2CAL_API_URL is not a URL: ${BASE}`);
  process.exit(1);
}
// Plain http is allowed only on loopback, where nothing leaves the machine;
// anywhere else the API key would travel in clear text.
const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
  console.error(`tap2cal-mcp: TAP2CAL_API_URL must use https (http only on localhost): ${BASE}`);
  process.exit(1);
}

const redact = (text) => String(text).split(KEY).join("<your API key>");

// Error codes of the API, explained so the assistant can tell the user what to do.
const EXPLAIN = {
  unauthenticated: "The API key is wrong or was deleted. Create a new one at https://tap2cal.com/app/account.",
  not_found: "No event of this account matches. Use list_my_events to see the events and their links.",
  invalid_name: "The name is missing or longer than 120 characters.",
  invalid_date: "Dates must be YYYY-MM-DD.",
  invalid_time: "Times must be HH:MM, and a start time needs an end time.",
  invalid_date_range: "The end must be after the start.",
  invalid_time_zone: "The time zone must be an IANA name such as Europe/Vienna.",
  invalid_link: "The link must start with http:// or https:// and be at most 500 characters.",
  invalid_color: "Colors must be #rrggbb.",
  invalid_slug: "The link needs at least 3 characters (a to z, digits, hyphens) and can't be a reserved word.",
  slug_taken: "This link is already used by another event. Pick a different one.",
  too_many_slug_changes: "This event already had 5 new links, which is the limit.",
  too_many_events: "The daily limit of new events for this account is reached. Try again tomorrow.",
  too_many_edits: "The daily limit of changes for this account is reached. Try again tomorrow.",
  too_many_flyers: "The daily limit of flyer uploads for this account is reached. Try again tomorrow.",
  service_busy: "Tap2Cal is busy right now. Try again later.",
  invalid_image: "The file is not an image Tap2Cal can read. Use JPEG, PNG or WebP.",
  flyer_too_large: "The image is larger than 8 MB.",
  flyer_rejected: "The image was rejected by the automatic check and is not published.",
};

class ApiError extends Error {}

async function api(method, path, { json, body, contentType } = {}) {
  const headers = { Authorization: `Bearer ${KEY}` };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (contentType) headers["Content-Type"] = contentType;

  let res;
  let text;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const reason = err?.name === "TimeoutError"
      ? `no response within ${TIMEOUT_MS} ms`
      : redact(err?.message || String(err));
    throw new ApiError(`Could not reach Tap2Cal: ${reason}`);
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!res.ok) {
    const code = data?.error;
    const hint = code && EXPLAIN[code] ? ` ${EXPLAIN[code]}` : "";
    throw new ApiError(`Tap2Cal returned HTTP ${res.status}${code ? ` (${code})` : ""}.${hint}`);
  }
  return data;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const run = (action) => async (args) => {
  try {
    return ok(await action(args));
  } catch (err) {
    const text = err instanceof ApiError ? err.message : `Error: ${redact(err?.message || err)}`;
    return { isError: true, content: [{ type: "text", text }] };
  }
};
const eventPath = (event) => `/events/${encodeURIComponent(String(event).trim())}`;
const pick = (args, keys) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

const EVENT_FIELDS = [
  "name", "startDate", "endDate", "startTime", "endTime", "timeZone", "location", "subtitle",
  "description", "link", "accentColor", "backgroundColor", "lang", "rsvpEnabled", "slug",
];
const eventArg = z.string().describe("The event: its id, any of its links or the full URL");
const clearable = (text) => z.string().nullable().optional()
  .describe(`${text}. Pass null or an empty string to remove it`);

const server = new McpServer({ name: "tap2cal", version: "1.0.0" });

server.registerTool("create_event", {
  title: "Create a calendar link",
  description:
    "Creates a public page for an event with a shareable link. Anyone who opens the " +
    "link can save the event to Google Calendar, Apple Calendar, Outlook or any other " +
    "calendar. Returns the event with its link in url. Anyone with the link can see " +
    "the event details, and the event is deleted 90 days after it ends.",
  inputSchema: z.object({
    name: z.string().describe("Event name, up to 120 characters"),
    startDate: z.string().describe("Start date as YYYY-MM-DD"),
    endDate: z.string().optional().describe("End date as YYYY-MM-DD, defaults to the start date"),
    startTime: z.string().optional().describe("Start time as HH:MM. Leave out for an all-day event"),
    endTime: z.string().optional().describe("End time as HH:MM, required with a start time"),
    timeZone: z.string().describe("IANA time zone, e.g. Europe/Vienna"),
    location: z.string().optional().describe("Location, up to 200 characters"),
    subtitle: z.string().optional().describe("Short subtitle, up to 160 characters"),
    description: z.string().optional().describe("Description, up to 1000 characters"),
    link: z.string().optional().describe("Related https link, e.g. tickets"),
    accentColor: z.string().optional().describe("Button color as #rrggbb"),
    backgroundColor: z.string().optional().describe("Page background color as #rrggbb"),
    lang: z.enum(LANGUAGES).optional().describe("Language of the link preview"),
    rsvpEnabled: z.boolean().optional().describe("Let guests accept or decline with their name"),
    slug: z.string().optional().describe(
      "Own link, e.g. summer-party for tap2cal.com/summer-party. At least 3 characters. " +
      "Leave out for a link made from the name"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, run(async (args) => (await api("POST", "/events", { json: pick(args, EVENT_FIELDS) })).event));

server.registerTool("list_my_events", {
  title: "List my calendar links",
  description:
    "Lists the events of this Tap2Cal account with their links, page views, calendar " +
    "button clicks and RSVP counts, newest start date first.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, run(() => api("GET", "/events")));

server.registerTool("get_event", {
  title: "Show a calendar link",
  description:
    "Returns one event with all its details, its current link, earlier links that still " +
    "work, page views, calendar button clicks and RSVP counts.",
  inputSchema: z.object({ event: eventArg }),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, run(async ({ event }) => (await api("GET", eventPath(event))).event));

server.registerTool("update_event", {
  title: "Change a calendar link",
  description:
    "Changes an event. Only the fields you pass change. Moving the start date without an " +
    "end date keeps the length of the event. Passing slug changes the link; the earlier " +
    "link keeps working until it is disabled with disable_old_link.",
  inputSchema: z.object({
    event: eventArg,
    name: z.string().optional().describe("Event name, up to 120 characters"),
    startDate: z.string().optional().describe("Start date as YYYY-MM-DD"),
    endDate: z.string().optional().describe("End date as YYYY-MM-DD"),
    startTime: clearable("Start time as HH:MM. Removing it makes the event all-day"),
    endTime: clearable("End time as HH:MM, required with a start time"),
    timeZone: z.string().optional().describe("IANA time zone, e.g. Europe/Vienna"),
    location: clearable("Location, up to 200 characters"),
    subtitle: clearable("Short subtitle, up to 160 characters"),
    description: clearable("Description, up to 1000 characters"),
    link: clearable("Related https link, e.g. tickets"),
    accentColor: clearable("Button color as #rrggbb"),
    backgroundColor: clearable("Page background color as #rrggbb"),
    lang: z.enum(LANGUAGES).optional().describe("Language of the link preview"),
    rsvpEnabled: z.boolean().optional().describe("Let guests accept or decline with their name"),
    slug: z.string().optional().describe(
      "New link, e.g. summer-party for tap2cal.com/summer-party. At least 3 characters, " +
      "up to 5 new links per event"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, run(async ({ event, ...changes }) =>
  (await api("PATCH", eventPath(event), { json: pick(changes, EVENT_FIELDS) })).event));

server.registerTool("disable_old_link", {
  title: "Disable an earlier link",
  description:
    "Disables an earlier link of an event, so it shows that the link is no longer valid. " +
    "The current link can't be disabled. Choosing the link again with update_event turns it back on.",
  inputSchema: z.object({
    event: eventArg,
    link: z.string().describe("The earlier link to disable, e.g. summer-party-x7k2 or its full URL"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, run(async ({ event, link }) => {
  const slug = String(link).trim().replace(/^(https?:\/\/)?[^/]*tap2cal\.com\//i, "");
  return (await api("DELETE", `${eventPath(event)}/links/${encodeURIComponent(slug)}`)).event;
}));

server.registerTool("list_rsvps", {
  title: "List RSVPs",
  description: "Lists the guests who accepted or declined an event, with the number of people each guest brings along.",
  inputSchema: z.object({ event: eventArg }),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, run(({ event }) => api("GET", `${eventPath(event)}/rsvps`)));

async function readImage(imagePath, imageUrl) {
  if (imagePath) {
    const info = await stat(imagePath);
    if (info.size > FLYER_MAX_BYTES) throw new ApiError("The image is larger than 8 MB.");
    return readFile(imagePath);
  }
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    throw new ApiError("Pass imagePath (a file on this computer) or imageUrl (http or https).");
  }
  let res;
  try {
    res = await fetch(imageUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ApiError(`Could not download the image: ${err?.message || err}`);
  }
  if (!res.ok) throw new ApiError(`Could not download the image: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > FLYER_MAX_BYTES) throw new ApiError("The image is larger than 8 MB.");
  return data;
}

server.registerTool("set_flyer", {
  title: "Add a flyer",
  description:
    "Adds or replaces the flyer of an event. It is shown on the event page and in link " +
    "previews. Pass a file on this computer or an image URL, JPEG, PNG or WebP up to 8 MB. " +
    "Images are checked automatically before they are published.",
  inputSchema: z.object({
    event: eventArg,
    imagePath: z.string().optional().describe("Path of an image file on this computer"),
    imageUrl: z.string().optional().describe("URL of an image to download"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, run(async ({ event, imagePath, imageUrl }) => {
  const image = await readImage(imagePath, imageUrl);
  return (await api("POST", `${eventPath(event)}/flyer`, {
    body: image, contentType: "application/octet-stream",
  })).event;
}));

server.registerTool("remove_flyer", {
  title: "Remove the flyer",
  description: "Removes the flyer of an event. The page and link preview go back to the design without image.",
  inputSchema: z.object({ event: eventArg }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, run(async ({ event }) => (await api("DELETE", `${eventPath(event)}/flyer`)).event));

server.registerTool("delete_event", {
  title: "Delete a calendar link",
  description:
    "Deletes an event with its page, all its links, its flyer and its RSVPs. The links " +
    "stop working right away. This can't be undone.",
  inputSchema: z.object({ event: eventArg }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, run(async ({ event }) => {
  await api("DELETE", eventPath(event));
  return { deleted: true };
}));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`tap2cal-mcp ready, API ${BASE}`);
