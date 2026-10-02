import type { WorkspaceMembershipRole } from "@tamishra/identity";

export type WorkspacePermission =
  | "workspace.read"
  | "workspace.manage"
  | "members.read"
  | "members.invite"
  | "members.manage"
  | "files.read"
  | "files.create"
  | "files.edit"
  | "files.delete"
  | "files.share"
  | "mail.read"
  | "mail.send"
  | "mail.manage"
  | "meet.join"
  | "meet.create"
  | "meet.moderate"
  | "chat.read"
  | "chat.send"
  | "chat.manage"
  | "forms.create"
  | "forms.manage"
  | "settings.manage"
  | "audit.read";

const ownerPermissions: WorkspacePermission[] = [
  "workspace.read",
  "workspace.manage",
  "members.read",
  "members.invite",
  "members.manage",
  "files.read",
  "files.create",
  "files.edit",
  "files.delete",
  "files.share",
  "mail.read",
  "mail.send",
  "mail.manage",
  "meet.join",
  "meet.create",
  "meet.moderate",
  "chat.read",
  "chat.send",
  "chat.manage",
  "forms.create",
  "forms.manage",
  "settings.manage",
  "audit.read"
];

const adminPermissions: WorkspacePermission[] = ownerPermissions.filter(
  (permission) => permission !== "workspace.manage"
);

const memberPermissions: WorkspacePermission[] = [
  "workspace.read",
  "members.read",
  "files.read",
  "files.create",
  "files.edit",
  "files.share",
  "mail.read",
  "mail.send",
  "meet.join",
  "meet.create",
  "chat.read",
  "chat.send",
  "forms.create"
];

const guestPermissions: WorkspacePermission[] = [
  "workspace.read",
  "files.read",
  "meet.join",
  "chat.read"
];

const rolePermissions: Record<WorkspaceMembershipRole, ReadonlySet<WorkspacePermission>> = {
  owner: new Set(ownerPermissions),
  admin: new Set(adminPermissions),
  member: new Set(memberPermissions),
  guest: new Set(guestPermissions)
};

export function permissionsForRole(role: WorkspaceMembershipRole) {
  return new Set(rolePermissions[role]);
}

export function hasPermission(
  role: WorkspaceMembershipRole,
  permission: WorkspacePermission
) {
  return rolePermissions[role].has(permission);
}

export function requirePermission(
  role: WorkspaceMembershipRole,
  permission: WorkspacePermission
) {
  if (!hasPermission(role, permission)) {
    throw new PermissionDeniedError(permission, role);
  }
}

export class PermissionDeniedError extends Error {
  constructor(
    readonly permission: WorkspacePermission,
    readonly role: WorkspaceMembershipRole
  ) {
    super(`Role "${role}" does not have permission "${permission}".`);
    this.name = "PermissionDeniedError";
  }
}


export type KoshRepositoryRole =
  | "owner"
  | "maintainer"
  | "contributor"
  | "reviewer"
  | "reader";

export type KoshRepositoryPermission =
  | "repository.read"
  | "repository.write"
  | "repository.review"
  | "repository.merge"
  | "repository.manage"
  | "automation.run"
  | "automation.manage"
  | "packages.publish"
  | "releases.manage"
  | "security.manage"
  | "access.manage";

const koshRolePermissions: Record<
  KoshRepositoryRole,
  ReadonlySet<KoshRepositoryPermission>
> = {
  owner: new Set<KoshRepositoryPermission>([
    "repository.read",
    "repository.write",
    "repository.review",
    "repository.merge",
    "repository.manage",
    "automation.run",
    "automation.manage",
    "packages.publish",
    "releases.manage",
    "security.manage",
    "access.manage"
  ]),
  maintainer: new Set<KoshRepositoryPermission>([
    "repository.read",
    "repository.write",
    "repository.review",
    "repository.merge",
    "repository.manage",
    "automation.run",
    "automation.manage",
    "packages.publish",
    "releases.manage",
    "security.manage",
    "access.manage"
  ]),
  contributor: new Set<KoshRepositoryPermission>([
    "repository.read",
    "repository.write",
    "repository.review",
    "automation.run",
    "packages.publish"
  ]),
  reviewer: new Set<KoshRepositoryPermission>([
    "repository.read",
    "repository.review"
  ]),
  reader: new Set<KoshRepositoryPermission>([
    "repository.read"
  ])
};

export function koshPermissionsForRole(role: KoshRepositoryRole) {
  return new Set(koshRolePermissions[role]);
}

export function koshHasPermission(
  role: KoshRepositoryRole,
  permission: KoshRepositoryPermission
) {
  return koshRolePermissions[role].has(permission);
}

export function koshRequirePermission(
  role: KoshRepositoryRole,
  permission: KoshRepositoryPermission
) {
  if (!koshHasPermission(role, permission)) {
    throw new KoshPermissionDeniedError(permission, role);
  }
}

export class KoshPermissionDeniedError extends Error {
  constructor(
    readonly permission: KoshRepositoryPermission,
    readonly role: KoshRepositoryRole
  ) {
    super(
      `Kosh role "${role}" does not have permission "${permission}".`
    );
    this.name = "KoshPermissionDeniedError";
  }
}
