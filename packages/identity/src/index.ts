export type UserId = string;
export type WorkspaceId = string;
export type OrganizationId = string;
export type SessionId = string;

export type WorkspaceUser = {
  id: UserId;
  email: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  disabled: boolean;
};

export type WorkspaceOrganization = {
  id: OrganizationId;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceMembershipRole =
  | "owner"
  | "admin"
  | "member"
  | "guest";

export type WorkspaceMembership = {
  id: string;
  userId: UserId;
  organizationId: OrganizationId;
  role: WorkspaceMembershipRole;
  joinedAt: string;
  disabled: boolean;
};

export type WorkspaceSession = {
  id: SessionId;
  userId: UserId;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
  ipHash?: string;
  revokedAt?: string;
};

export type NativeCredentialMethod =
  | "password"
  | "passkey"
  | "recovery-code";

export type AuthCapabilities = {
  password: boolean;
  passkey: boolean;
  recoveryCodes: boolean;
  emailVerification: boolean;
  externalIdentityProviders: false;
};

export const nativeAuthCapabilities: AuthCapabilities = {
  password: true,
  passkey: true,
  recoveryCodes: true,
  emailVerification: true,
  externalIdentityProviders: false
};

export type SignInRequest = {
  email: string;
  password: string;
  remember?: boolean;
};

export type SignInResult = {
  user: WorkspaceUser;
  session: WorkspaceSession;
};

export type RegistrationRequest = {
  email: string;
  displayName: string;
  password: string;
};

export type PasswordResetRequest = {
  email: string;
};

export type PasswordResetCompleteRequest = {
  token: string;
  password: string;
};

export type IdentityAuditAction =
  | "user.registered"
  | "user.verified"
  | "session.created"
  | "session.revoked"
  | "password.changed"
  | "password.reset.requested"
  | "password.reset.completed"
  | "passkey.registered"
  | "passkey.removed";

export interface IdentityGateway {
  capabilities(): Promise<AuthCapabilities>;
  register(input: RegistrationRequest): Promise<SignInResult>;
  signIn(input: SignInRequest): Promise<SignInResult>;
  signOut(sessionId: SessionId): Promise<void>;
  currentSession(): Promise<SignInResult | null>;
  requestPasswordReset(input: PasswordResetRequest): Promise<void>;
  completePasswordReset(input: PasswordResetCompleteRequest): Promise<void>;
  listSessions(): Promise<WorkspaceSession[]>;
  revokeSession(sessionId: SessionId): Promise<void>;
}
