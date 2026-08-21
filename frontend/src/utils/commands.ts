import { fuzzyFilter } from './fuzzySearch';

export type CommandCategory = 'Navigation' | 'Workspace' | 'Execution' | 'UI' | 'Admin' | 'General' | 'Collaboration' | 'AI';

export interface Command {
  id: string;
  title: string;
  description?: string;
  category: CommandCategory;
  shortcut?: string;
  macShortcut?: string;
  icon?: string;
  available?: () => boolean;
  handler: () => void | Promise<void>;
}

export class CommandRegistry {
  private static instance: CommandRegistry;
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();

  public static getInstance(): CommandRegistry {
    if (!CommandRegistry.instance) {
      CommandRegistry.instance = new CommandRegistry();
    }
    return CommandRegistry.instance;
  }

  public register(command: Command): () => void {
    this.commands.set(command.id, command);
    this.notify();
    return () => {
      this.commands.delete(command.id);
      this.notify();
    };
  }

  public registerMany(commands: Command[]): () => void {
    for (const cmd of commands) {
      this.commands.set(cmd.id, cmd);
    }
    this.notify();
    return () => {
      for (const cmd of commands) {
        this.commands.delete(cmd.id);
      }
      this.notify();
    };
  }

  public unregister(id: string): void {
    this.commands.delete(id);
    this.notify();
  }

  public get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  public getAll(): Command[] {
    return Array.from(this.commands.values());
  }

  public getAvailable(): Command[] {
    return this.getAll().filter((c) => (c.available ? c.available() : true));
  }

  public async execute(id: string): Promise<boolean> {
    const cmd = this.commands.get(id);
    if (!cmd) return false;
    if (cmd.available && !cmd.available()) return false;

    try {
      await cmd.handler();
      return true;
    } catch (err) {
      console.error(`[CommandRegistry] Failed to execute command ${id}:`, err);
      return false;
    }
  }

  public search(query: string): Command[] {
    const available = this.getAvailable();
    if (!query || !query.trim()) {
      return available;
    }

    const filtered = fuzzyFilter(available, query, (cmd) => `${cmd.category} ${cmd.title} ${cmd.description || ''}`);
    return filtered.map((r) => r.item);
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
