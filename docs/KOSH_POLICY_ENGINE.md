# Kosh Policy Engine

Kosh Policy Engine is the native policy-as-code control plane for Kosh. It is not a compatibility wrapper around another development platform.

## Goals

- centralize enforceable repository and platform rules
- keep policy decisions deterministic and explainable
- support repository-scoped and platform-wide policy layers
- preserve an observe-only mode for safe rollout
- return evidence for every matched rule
- audit policy lifecycle changes and interactive evaluations

## Targets

Policies can target:

- `merge`
- `automation`
- `deployment`
- `package`
- `storage`
- `extension`
- `repository`

Actions are explicit strings such as `merge.execute`, `deployment.promote`, or `package.publish`. `*` wildcards are supported in action patterns.

## Effects

- `allow`
- `require`
- `deny`

For enforcing policies, precedence is deterministic:

`deny` > `require` > `allow` > `neutral`

Policies in `observe` mode are included in evidence but never change the enforcement decision.

## Conditions

Each rule can include up to 32 conditions over a bounded context object. Supported operators:

- `equals`
- `not_equals`
- `in`
- `not_in`
- `exists`
- `contains`

Condition fields use dot paths such as `branch.name`, `release.channel`, or `actor.role`.

## Repository API

Root:

`/v1/kosh/repos/<namespace>/<repository>/policies`

- `GET /policies` — list non-archived repository policies
- `POST /policies` — create a repository policy
- `GET /policies/<id>` — inspect one policy
- `PATCH /policies/<id>` — update policy definition or enable/disable it
- `DELETE /policies/<id>` — archive a policy
- `POST /policies/evaluate` — evaluate target/action/context against repository and global policies

Repository reads require `repository.read`. Mutations and interactive evaluation require `repository.manage` through the repository authorization layer.

## Global API

Root:

`/v1/kosh/systems/policies`

The same collection/detail/evaluation routes are available for platform-wide policies. Global access requires a Kosh platform administrator. In production this is controlled by `KOSH_PLATFORM_ADMIN_USER_IDS`.

## Definition example

```json
{
  "key": "protected-production-deployments",
  "name": "Protected production deployments",
  "mode": "enforce",
  "priority": 200,
  "description": "Require explicit production evidence before promotion.",
  "rules": [
    {
      "key": "require-approved-release",
      "target": "deployment",
      "action": "deployment.promote",
      "effect": "require",
      "message": "Production promotion requires an approved release.",
      "conditions": [
        {
          "field": "environment",
          "operator": "equals",
          "value": "production"
        }
      ]
    }
  ]
}
```

## Evaluation response

The engine returns:

- final decision
- target and action
- all matched rule evidence
- blocking `deny` and `require` evidence

Observe-mode matches remain visible so administrators can measure a rule before enabling enforcement.

## Security boundaries

- mutation requests reject untrusted browser origins
- repository policies are protected by repository ACLs
- global policies are protected by platform-admin authorization
- inputs are size- and depth-bounded
- policy identifiers, targets, actions and condition paths are validated
- archived policies do not participate in evaluation
- every policy revision increments monotonically

## Enforcement integration

The exported evaluator is designed for Kosh service gates. Merge, automation, deployment, package, storage, extension and repository services can call the same evaluator with their native context and reject or hold an operation when the returned decision is `deny` or `require`.
