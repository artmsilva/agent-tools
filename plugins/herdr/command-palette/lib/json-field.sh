# shellcheck shell=sh
json_field() {
	json=$1
	field=$2
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$json" | jq -r "$field // empty" 2>/dev/null || true
	elif command -v node >/dev/null 2>&1; then
		HERDR_JSON=$json HERDR_FIELD=$field node <<'NODE' 2>/dev/null || true
const data = JSON.parse(process.env.HERDR_JSON || '{}');
const field = process.env.HERDR_FIELD || '';
const path = field.replace(/^\./, '').split('.').filter(Boolean);
let value = data;
for (const key of path) value = value && typeof value === 'object' ? value[key] : undefined;
if (typeof value === 'string') process.stdout.write(value);
NODE
	fi
}
