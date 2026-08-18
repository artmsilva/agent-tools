#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const required = ["site", "email", "project", "issueType", "assignee", "boardId", "sprintNameIncludes", "componentId", "storyPointsField", "sprintFields"];

export function markdownToWiki(text) {
  return text
    .replace(/^#### (.+)$/gm, "h4. $1")
    .replace(/^### (.+)$/gm, "h3. $1")
    .replace(/^## (.+)$/gm, "h2. $1")
    .replace(/^# (.+)$/gm, "h1. $1")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/`([^`]+)`/g, "{{$1}}")
    .replace(/^- /gm, "* ")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "[$1|$2]");
}

export function parseArgs(args) {
  const options = { points: undefined };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (["--help", "-h"].includes(key)) options.help = true;
    else if (["--summary", "-s"].includes(key)) options.summary = args[++i];
    else if (["--description", "-d"].includes(key)) options.description = args[++i];
    else if (["--points", "-p"].includes(key)) options.points = Number(args[++i]);
    else if (["--fix", "-f"].includes(key)) options.fix = args[++i];
    else if (!options.summary) options.summary = key;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (options.points !== undefined && (!Number.isFinite(options.points) || options.points < 0)) throw new Error("Points must be a non-negative number");
  return options;
}

function usage() {
  console.log(`Usage: jira-create-ticket --summary "Title" [--description "Desc"] [--points N]\n       jira-create-ticket --fix KEY\n\nConfig: ~/.config/jira-create-ticket/config.json (override with JIRA_CREATE_CONFIG)`);
}

function loadConfig() {
  const path = resolve(process.env.JIRA_CREATE_CONFIG || `${homedir()}/.config/jira-create-ticket/config.json`);
  const config = JSON.parse(readFileSync(path, "utf8"));
  const missing = required.filter(key => config[key] === undefined || config[key] === "");
  if (missing.length) throw new Error(`Missing config: ${missing.join(", ")}`);
  if (!Array.isArray(config.sprintFields) || !config.sprintFields.length) throw new Error("sprintFields must be a non-empty array");
  return { defaultPoints: 5, ...config };
}

function token(config) {
  if (process.env.JIRA_API_TOKEN) return process.env.JIRA_API_TOKEN;
  if (!config.tokenCommand) throw new Error("Set JIRA_API_TOKEN or config.tokenCommand");
  return execSync(config.tokenCommand, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function acli(args) {
  return execFileSync("acli", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function request(config, apiToken, path, { method = "GET", body, query } = {}) {
  const url = new URL(`https://${config.site}${path}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  return fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.email}:${apiToken}`).toString("base64")}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function activeSprint(config) {
  const data = JSON.parse(acli(["jira", "board", "list-sprints", "--id", String(config.boardId), "--state", "active", "--json"]));
  return data.sprints?.find(sprint => sprint.name.includes(config.sprintNameIncludes))?.id;
}

async function waitForIssue(config, apiToken, key) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    if ((await request(config, apiToken, `/rest/api/3/issue/${key}`, { query: { fields: "key" } })).ok) return;
    await sleep(attempt * 1000);
  }
}

async function checked(response, message) {
  if (response.ok) return response;
  throw new Error(`${message}: ${response.status} ${await response.text()}`);
}

async function setRequiredFields(config, apiToken, key, sprintId, points, description) {
  console.log("Setting required fields...");
  let response;
  for (let attempt = 1; attempt <= 4; attempt++) {
    response = await request(config, apiToken, `/rest/api/3/issue/${key}`, {
      method: "PUT",
      body: { fields: { components: [{ id: String(config.componentId) }], [config.storyPointsField]: points } },
    });
    if (response.ok) break;
    if (attempt < 4 && [403, 404].includes(response.status)) await sleep(attempt * 2000);
    else await checked(response, "Could not set component and story points");
  }

  if (description) await checked(await request(config, apiToken, `/rest/api/2/issue/${key}`, {
    method: "PUT",
    body: { fields: { description: markdownToWiki(description) } },
  }), "Could not set description");

  await checked(await request(config, apiToken, `/rest/agile/1.0/sprint/${sprintId}/issue`, {
    method: "POST",
    body: { issues: [key] },
  }), "Could not add ticket to sprint");

  const fields = ["components", ...config.sprintFields].join(",");
  const verify = await checked(await request(config, apiToken, `/rest/api/3/issue/${key}`, { query: { fields } }), "Could not verify ticket");
  const data = await verify.json();
  if (!data.fields.components?.length) throw new Error(`${key} has no component after update`);
  if (!config.sprintFields.some(field => data.fields[field]?.length)) throw new Error(`${key} has no sprint after update`);
  console.log("✓ Required fields verified");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (!options.summary && !options.fix) throw new Error("Summary is required, or pass --fix KEY");

  const config = loadConfig();
  const apiToken = token(config);
  if (!apiToken) throw new Error("Jira API token command returned nothing");
  const sprintId = activeSprint(config);
  if (!sprintId) throw new Error("No matching active sprint; refusing to create a ticket");
  const points = options.points ?? config.defaultPoints;

  if (options.fix) {
    await waitForIssue(config, apiToken, options.fix);
    await setRequiredFields(config, apiToken, options.fix, sprintId, points, options.description);
    console.log(`✓ Repaired https://${config.site}/browse/${options.fix}`);
    return;
  }

  console.log("Creating ticket...");
  const output = acli(["jira", "workitem", "create", "--project", config.project, "--type", config.issueType, "--summary", options.summary, "--assignee", config.assignee]);
  const key = output.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
  if (!key) throw new Error(`Could not read ticket key from acli output: ${output}`);
  await waitForIssue(config, apiToken, key);
  await setRequiredFields(config, apiToken, key, sprintId, points, options.description);
  console.log(`✓ Created https://${config.site}/browse/${key}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
