export const publicPatraDomain = "patra.in";
export const tamishraCompanyDomain = "tamishra.in";

export type NativeMailboxClass = "public" | "tamishra-company";

export type NativeMailboxDomainPolicy = {
  mailboxClass: NativeMailboxClass;
  domain: string;
  selfRegistration: boolean;
  requiresCompanyAuthorization: boolean;
};

export const nativeMailboxDomainPolicies: Record<
  NativeMailboxClass,
  NativeMailboxDomainPolicy
> = {
  public: {
    mailboxClass: "public",
    domain: publicPatraDomain,
    selfRegistration: true,
    requiresCompanyAuthorization: false
  },
  "tamishra-company": {
    mailboxClass: "tamishra-company",
    domain: tamishraCompanyDomain,
    selfRegistration: false,
    requiresCompanyAuthorization: true
  }
};

export function normalizeMailboxUsername(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
}

export function mailboxAddress(
  username: string,
  mailboxClass: NativeMailboxClass = "public"
) {
  const localPart = normalizeMailboxUsername(username);
  if (!localPart) throw new Error("invalid_mailbox_username");
  return localPart + "@" + nativeMailboxDomainPolicies[mailboxClass].domain;
}

export function canSelfRegisterMailboxClass(mailboxClass: NativeMailboxClass) {
  return nativeMailboxDomainPolicies[mailboxClass].selfRegistration;
}
