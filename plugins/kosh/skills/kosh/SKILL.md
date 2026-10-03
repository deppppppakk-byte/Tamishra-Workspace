---
name: kosh
summary: Inspect Kosh repositories, work, automation, releases and readiness through the Kosh MCP server.
---

Use Kosh tools when the user asks about repositories or development work stored in Kosh.

Prefer the narrowest read tool that answers the request:

- list_repositories for discovery
- get_repository for repository metadata
- search_repository for code, path or commit lookup
- list_issues for work tracking
- list_workflow_runs for Automation status
- list_releases for release history
- repository_readiness for production-readiness evidence

Never ask the user to paste a Kosh API token into the conversation. Authentication belongs to the connected MCP server. Treat readiness and operational results as evidence, not as guarantees about external systems Kosh cannot verify.
