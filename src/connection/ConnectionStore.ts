import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import type { ConnectionDraft, ConnectionProfile } from './types.js';

const PROFILES_KEY = 'rindaMysql.connectionProfiles.v1';
const SECRET_PREFIX = 'rindaMysql.password.';

export class ConnectionStore {
  public constructor(
    private readonly state: vscode.Memento,
    private readonly secrets: vscode.SecretStorage
  ) {}

  public list(): ConnectionProfile[] {
    return [...(this.state.get<ConnectionProfile[]>(PROFILES_KEY) ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public get(id: string): ConnectionProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  public async create(draft: ConnectionDraft): Promise<ConnectionProfile> {
    const now = new Date().toISOString();
    const profile: ConnectionProfile = {
      id: randomUUID(),
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: draft.port,
      user: draft.user.trim(),
      database: draft.database?.trim() || undefined,
      ssl: draft.ssl,
      createdAt: now,
      updatedAt: now
    };

    await this.state.update(PROFILES_KEY, [...this.list(), profile]);
    await this.secrets.store(this.secretKey(profile.id), draft.password);
    return profile;
  }

  public async update(
    id: string,
    draft: Omit<ConnectionDraft, 'password'> & { password?: string }
  ): Promise<ConnectionProfile> {
    const current = this.getRequired(id);
    const profile: ConnectionProfile = {
      ...current,
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: draft.port,
      user: draft.user.trim(),
      database: draft.database?.trim() || undefined,
      ssl: draft.ssl,
      updatedAt: new Date().toISOString()
    };
    const profiles = this.list().map((item) => item.id === id ? profile : item);
    await this.state.update(PROFILES_KEY, profiles);
    if (draft.password !== undefined && draft.password.length > 0) {
      await this.secrets.store(this.secretKey(id), draft.password);
    }
    return profile;
  }

  public async remove(id: string): Promise<void> {
    await this.state.update(PROFILES_KEY, this.list().filter((profile) => profile.id !== id));
    await this.secrets.delete(this.secretKey(id));
  }

  public getPassword(id: string): Thenable<string | undefined> {
    return this.secrets.get(this.secretKey(id));
  }

  public getRequired(id: string): ConnectionProfile {
    const profile = this.get(id);
    if (!profile) {
      throw new Error('连接配置不存在或已被删除。');
    }
    return profile;
  }

  private secretKey(id: string): string {
    return `${SECRET_PREFIX}${id}`;
  }
}
