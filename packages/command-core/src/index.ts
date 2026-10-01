export type CommandContext = Record<string, unknown>;

export type Command<TContext extends CommandContext = CommandContext> = {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  shortcut?: string;
  isEnabled?: (context: TContext) => boolean;
  run: (context: TContext) => void | Promise<void>;
};

export class CommandRegistry<TContext extends CommandContext = CommandContext> {
  private commands = new Map<string, Command<TContext>>();

  register(command: Command<TContext>): () => void {
    if (this.commands.has(command.id)) {
      throw new Error(`Command already registered: ${command.id}`);
    }

    this.commands.set(command.id, command);
    return () => this.commands.delete(command.id);
  }

  replace(command: Command<TContext>): void {
    this.commands.set(command.id, command);
  }

  get(id: string): Command<TContext> | undefined {
    return this.commands.get(id);
  }

  list(context?: TContext): Command<TContext>[] {
    return Array.from(this.commands.values()).filter(
      (command) => !context || !command.isEnabled || command.isEnabled(context)
    );
  }

  search(query: string, context?: TContext): Command<TContext>[] {
    const normalized = query.trim().toLowerCase();
    const available = this.list(context);

    if (!normalized) return available;

    return available.filter((command) => {
      const haystack = [
        command.id,
        command.label,
        command.description ?? "",
        ...(command.keywords ?? [])
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalized);
    });
  }

  async execute(id: string, context: TContext): Promise<boolean> {
    const command = this.commands.get(id);

    if (!command) return false;
    if (command.isEnabled && !command.isEnabled(context)) return false;

    await command.run(context);
    return true;
  }
}
