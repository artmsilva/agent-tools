# Gondolin

## Language

**Host**:
The trusted environment that owns policy, credentials, and approval decisions.
_Avoid_: Local machine, main system

**Guest**:
The isolated environment where delegated file and shell operations execute.
_Avoid_: Sandbox process, container

**Allowlist**:
The combined policy describing which external hosts the Guest may reach.
_Avoid_: Whitelist, firewall rules

**Egress gate**:
The enforcement boundary that evaluates an outbound destination against the Allowlist before access is granted.
_Avoid_: Proxy, firewall

**Provisioned workspace**:
The project workspace and curated capabilities made available inside the Guest for one Pi session.
_Avoid_: Configured environment, initialized container

**Telemetry**:
Lifecycle observations used to measure startup and readiness without granting the Guest additional authority.
_Avoid_: Analytics, logging
