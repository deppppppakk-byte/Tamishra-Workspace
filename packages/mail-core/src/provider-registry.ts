import type { MailProvider, MailProviderCapabilities } from "./index";

export type MailConnectionMethod = "native" | "server";

export type MailProviderDescriptor = {
  key: string;
  name: string;
  description: string;
  connectionMethod: MailConnectionMethod;
  capabilities: MailProviderCapabilities;
  recommended?: boolean;
  fields?: Array<{
    key: string;
    label: string;
    type: "text" | "email" | "password" | "number";
    placeholder?: string;
    secret?: boolean;
  }>;
};

export const builtInMailProviders: MailProviderDescriptor[] = [
  {
    key: "tamishra",
    name: "Tamishra Patra",
    description: "First-party Tamishra Patra service owned and operated by Tamishra Workspace.",
    connectionMethod: "native",
    recommended: true,
    capabilities: {
      folders: true,
      labels: true,
      threads: true,
      drafts: true,
      search: true,
      pushSync: true
    }
  },
  {
    key: "imap-smtp",
    name: "Custom Mail Server",
    description: "Optional standards-based IMAP and SMTP connection for independent mail servers.",
    connectionMethod: "server",
    capabilities: {
      folders: true,
      labels: false,
      threads: false,
      drafts: true,
      search: true,
      pushSync: false
    },
    fields: [
      { key: "email", label: "Email address", type: "email", placeholder: "you@yourdomain.com" },
      { key: "imapHost", label: "IMAP host", type: "text", placeholder: "imap.yourdomain.com" },
      { key: "imapPort", label: "IMAP port", type: "number", placeholder: "993" },
      { key: "smtpHost", label: "SMTP host", type: "text", placeholder: "smtp.yourdomain.com" },
      { key: "smtpPort", label: "SMTP port", type: "number", placeholder: "465 or 587" },
      { key: "username", label: "Username", type: "text" },
      { key: "password", label: "Mail password", type: "password", secret: true }
    ]
  }
];

export class MailProviderRegistry {
  private readonly providers = new Map<string, MailProvider>();

  register(provider: MailProvider) {
    if (this.providers.has(provider.key)) {
      throw new Error(`Mail provider "${provider.key}" is already registered.`);
    }

    this.providers.set(provider.key, provider);
    return this;
  }

  replace(provider: MailProvider) {
    this.providers.set(provider.key, provider);
    return this;
  }

  get(key: string) {
    return this.providers.get(key);
  }

  require(key: string) {
    const provider = this.providers.get(key);

    if (!provider) {
      throw new Error(`Mail provider "${key}" is not registered.`);
    }

    return provider;
  }

  has(key: string) {
    return this.providers.has(key);
  }

  list() {
    return Array.from(this.providers.values());
  }
}
