const $ = (selector) => document.querySelector(selector);

function cell(value, className = "", colSpan = 1) {
  const element = document.createElement("td");
  element.className = className;
  element.colSpan = colSpan;
  element.textContent = value;
  return element;
}

function row(values) {
  const element = document.createElement("tr");
  element.append(...values);
  return element;
}

function badge(value, kind = "secondary") {
  const element = document.createElement("span");
  element.className = `badge text-bg-${kind}`;
  element.textContent = value;
  return element;
}

function renderEnvironment(snapshot) {
  const body = $("#environment-body");
  const piExtensions = snapshot.pi.resources.extensions.length;
  const claudeHooks = snapshot.claude.hooks.length;
  body.replaceChildren(
    row([
      cell("Pi", "fw-semibold"),
      cell(`${snapshot.pi.provider} / ${snapshot.pi.model}`, "font-monospace small"),
      cell(snapshot.pi.theme),
      cell(String(snapshot.pi.resources.skills.length)),
      cell(String(snapshot.pi.resources.agents.length)),
      cell(String(snapshot.pi.resources.commands.length)),
      cell(`${piExtensions} extensions`),
    ]),
    row([
      cell("Claude Code", "fw-semibold"),
      cell(snapshot.claude.model, "font-monospace small"),
      cell(snapshot.claude.theme),
      cell(String(snapshot.claude.resources.skills.length)),
      cell(String(snapshot.claude.resources.agents.length)),
      cell(String(snapshot.claude.resources.commands.length)),
      cell(`${claudeHooks} hook event types`),
    ]),
  );
}

function mcpRows(owner, servers, overrides) {
  return servers.map((server) => row([
    cell(owner),
    cell(server.name, "font-monospace"),
    cell(server.transport),
    cell(server.target, "font-monospace small"),
    cell(overrides.includes(server.name) ? "Pi override" : "single source"),
  ]));
}

function renderMcp(snapshot) {
  const overrides = snapshot.shared.mcpOverrides;
  $("#mcp-note").textContent = `${snapshot.pi.mcp.length + snapshot.claude.mcp.length + snapshot.claude.projectMcp.length} configured entries · ${overrides.length} Pi overrides`;
  $("#mcp-body").replaceChildren(
    ...mcpRows("Pi", snapshot.pi.mcp, overrides),
    ...mcpRows("Claude user", snapshot.claude.mcp, overrides),
    ...mcpRows("Claude project", snapshot.claude.projectMcp, []),
  );
}

function renderResources(snapshot) {
  const resources = [
    ["Pi", "skills", snapshot.pi.resources.skills],
    ["Pi", "agents", snapshot.pi.resources.agents],
    ["Pi", "commands", snapshot.pi.resources.commands],
    ["Pi", "extensions", snapshot.pi.resources.extensions],
    ["Claude", "skills", snapshot.claude.resources.skills],
    ["Claude", "agents", snapshot.claude.resources.agents],
    ["Claude", "commands", snapshot.claude.resources.commands],
    ["Claude", "hook events", snapshot.claude.hooks],
  ];
  $("#resource-body").replaceChildren(...resources.map(([owner, kind, names]) => row([
    cell(owner),
    cell(kind),
    cell(String(names.length)),
    cell(names.join(", ") || "—", "font-monospace small text-break"),
  ])));
}

function renderPlugins(plugins) {
  const body = $("#plugin-body");
  body.replaceChildren(...plugins.map((plugin) => {
    const state = cell("", "text-end");
    state.append(badge(plugin.installed ? "installed" : "missing", plugin.installed ? "success" : "danger"));
    return row([cell(plugin.name, "font-monospace small"), cell(plugin.version), state]);
  }));
  if (!plugins.length) body.append(row([cell("No enabled plugins", "text-body-secondary", 3)]));
}

function renderSources(paths) {
  const labels = {
    piSettings: "Pi settings",
    piMcp: "Pi MCP",
    claudeSettings: "Claude settings",
    claudeMcp: "Claude user MCP",
    claudeProjectMcp: "Claude project MCP",
    claudePlugins: "Plugin registry",
  };
  $("#source-body").replaceChildren(...Object.entries(labels).map(([key, label]) => row([
    cell(label),
    cell(paths[key], "font-monospace small text-break"),
  ])));
}

function renderHealth(health) {
  const list = $("#health");
  if (!health.length) {
    const item = document.createElement("li");
    item.className = "list-group-item text-success";
    item.textContent = "Clear — no broken Pi links or enabled-but-missing Claude plugins.";
    list.replaceChildren(item);
    return;
  }
  list.replaceChildren(...health.map((message) => {
    const item = document.createElement("li");
    item.className = "list-group-item text-warning-emphasis";
    item.textContent = message;
    return item;
  }));
}

function render(snapshot) {
  $("#updated").textContent = `scanned ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
  renderEnvironment(snapshot);
  renderMcp(snapshot);
  renderResources(snapshot);
  renderPlugins(snapshot.claude.plugins);
  renderSources(snapshot.paths);
  renderHealth(snapshot.health);
}

async function refresh() {
  const button = $("#refresh");
  button.disabled = true;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to scan local configuration");
    render(await response.json());
  } catch (error) {
    $("#updated").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$("#refresh").addEventListener("click", refresh);
refresh();
