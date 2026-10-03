# Kosh Projects Command Center

The Projects Command Center is a dedicated Kosh planning workspace built on the native Advanced Project Management resources already exposed by the Kosh Systems control plane.

## Route

```text
/apps/kosh/projects?namespace=<namespace>&slug=<repository>
```

It uses the existing repository-scoped API:

```text
GET   /v1/kosh/repos/<ns>/<repo>/systems/projects
POST  /v1/kosh/repos/<ns>/<repo>/systems/projects
POST  /v1/kosh/repos/<ns>/<repo>/systems/projects/<project-id>/items
POST  /v1/kosh/repos/<ns>/<repo>/systems/projects/<project-id>/iterations
POST  /v1/kosh/repos/<ns>/<repo>/systems/projects/<project-id>/fields
PATCH /v1/kosh/repos/<ns>/<repo>/systems/projects/resources/<resource-id>
```

Repository reads continue to require `repository.read`. Project mutations continue to require `repository.manage`; the web workspace does not create a weaker authorization path.

## Workspace capabilities

- dedicated repository project list
- create roadmap containers with owner, description and due date
- project lifecycle states: active, paused, completed and archived
- progress metrics based on completed planning items
- four-column planning board for todo, in-progress, blocked and done work
- move planning items between supported states
- create and manage time-boxed iterations
- iteration lifecycle states: planned, active and completed
- iteration start/end date validation in the client before submission
- create typed custom fields
- select-field option authoring
- roadmap summary with owner, start, due date, ordering and completion progress
- responsive desktop/mobile workspace

## Resource model

The Command Center does not introduce another database model. It consumes the same `project_field` resources created by the Kosh Systems API:

- `project`
- `iteration`
- `field`
- `item`

This keeps the planning UI, API, audit trail and persistence model aligned.

## Safety boundary

The interface constrains user-selectable project, item and iteration states to the supported workspace lifecycle values and validates iteration date order before sending a mutation. These client checks are usability safeguards only; the Gateway remains the authorization and persistence boundary.
