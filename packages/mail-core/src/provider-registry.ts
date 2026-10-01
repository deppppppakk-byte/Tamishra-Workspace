import type { MailProvider, MailProviderCapabilities } from "./index";

export type MailConnectionMethod = "oauth" | "password" | "app-password" | "native";

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
    key: "google",
    name: "Google Mail",
    description: "Connect a Google account through OAuth. Tokens must be stored outside the browser.",
    connectionMethod: "oauth",
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
    key: "microsoft",
    name: "Microsoft Mail",
    description: "Connect Microsoft 365 or Outlook mail through OAuth.",
    connectionMethod: "oauth",
    capabilities: {
      folders: true,
      labels: false,
      threads: true,
      drafts: true,
      search: true,
      pushSync: true
    }
  },
  {
    key: "imap-smtp",
    name: "IMAP + SMTP",
    description: "Connect standards-based mail servers without coupling the app to one vendor.",
    connectionMethod: "password",
    capabilities: {
      folders: true,
      labels: false,
      threads: false,
      drafts: true,
      search: true,
      pushSync: false
    },
    fields: [
      { key: "email", label: "Email address", type: "email", placeholder: "you@example.com" },
      { key: "imapHost", label: "IMAP host", type: "text", placeholder: "imap.example.com" },
      { key: "imapPort", label: "IMAP port", type: "number", placeholder: "993" },
      { key: "smtpHost", label: "SMTP host", type: "text", placeholder: "smtp.example.com" },
      { key: "smtpPort", label: "SMTP port", type: "number", placeholder: "465 or 587" },
      { key: "username", label: "Username", type: "text" },
      { key: "password", label: "Password / app password", type: "password", secret: true }
    ]
  },
  {
    key: "tamishra",
    name: "Tamishra Mail",
    description: "Future first-party mailbox service using the same provider contract.",
    connectionMethod: "native",
    capabilities: {
      folders: true,
      labels: true,
      threads: true,
      drafts: true,
      search: true,
      pushSync: true
    }
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
