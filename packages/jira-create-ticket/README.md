# jira-create-ticket

Small dependency-free Node CLI for creating Jira tickets with locally required defaults.

## Configure

Create `~/.config/jira-create-ticket/config.json` and keep it out of Git:

```json
{
  "site": "your-company.atlassian.net",
  "email": "you@example.com",
  "project": "PROJECT",
  "issueType": "Task",
  "assignee": "you@example.com",
  "boardId": "123",
  "sprintNameIncludes": "Team Name",
  "componentId": "456",
  "storyPointsField": "customfield_123",
  "sprintFields": ["customfield_456"],
  "defaultPoints": 5,
  "tokenCommand": "op read 'op://vault/item/credential'"
}
```

Alternatively, set `JIRA_API_TOKEN` instead of `tokenCommand`. Override the config path with `JIRA_CREATE_CONFIG`.

## Install

```sh
cd packages/jira-create-ticket
npm link
```

## Use

```sh
jira-create-ticket --summary "Title" --description "## Scope\n- Do the work" --points 5
jira-create-ticket --fix PROJECT-123
```

The CLI resolves the active sprint before creating anything, creates through `acli`, then sets and verifies the configured component, story points, and sprint. It never adds labels.
