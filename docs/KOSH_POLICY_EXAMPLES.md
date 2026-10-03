# Kosh Policy Examples

These examples use Kosh-native targets, actions and context fields.

## Observe production promotion

```json
{
  "key": "observe-production-promotion",
  "name": "Observe production promotion",
  "mode": "observe",
  "priority": 100,
  "rules": [
    {
      "key": "production-promotion",
      "target": "deployment",
      "action": "deployment.promote",
      "effect": "require",
      "message": "Production promotion should include release evidence.",
      "conditions": [
        { "field": "environment", "operator": "equals", "value": "production" }
      ]
    }
  ]
}
```

## Deny unapproved extension activation

```json
{
  "key": "extension-egress-control",
  "name": "Extension egress control",
  "mode": "enforce",
  "priority": 250,
  "rules": [
    {
      "key": "deny-unapproved-egress",
      "target": "extension",
      "action": "extension.activate",
      "effect": "deny",
      "message": "Extensions with outbound network permission require platform approval.",
      "conditions": [
        { "field": "permissions", "operator": "contains", "value": "network.egress" },
        { "field": "approved", "operator": "not_equals", "value": true }
      ]
    }
  ]
}
```

## Require protected branch merge evidence

```json
{
  "key": "protected-branch-merge",
  "name": "Protected branch merge",
  "mode": "enforce",
  "priority": 300,
  "rules": [
    {
      "key": "require-protected-branch-proof",
      "target": "merge",
      "action": "merge.execute",
      "effect": "require",
      "message": "Protected branch merges require the configured review and check evidence.",
      "conditions": [
        { "field": "branch.protected", "operator": "equals", "value": true }
      ]
    }
  ]
}
```

Start new rules in `observe` mode, inspect evaluation evidence, then switch to `enforce` after the context and conditions are verified.
