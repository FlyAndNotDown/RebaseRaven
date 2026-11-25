// A tab can close and reopen at the same path while a native command is running.
// Keep its write queue until it drains, but revoke the old tab's publication rights.
export class RepositoryOperations {
  private sessions = new Map<string, { revision: number; writing: boolean }>();
  private writes = new Map<string, Promise<void>>();
  private background = new Map<string, AbortController>();

  private session(id: string) {
    let session = this.sessions.get(id);
    if (!session) {
      session = { revision: 0, writing: false };
      this.sessions.set(id, session);
    }
    return session;
  }

  close(id: string) {
    this.sessions.delete(id);
    this.background.get(id)?.abort();
  }

  owner(id: string) {
    const session = this.session(id);
    return () => this.sessions.get(id) === session;
  }

  pendingWrite(id: string) {
    return this.writes.get(id);
  }

  read(id: string) {
    const session = this.session(id);
    const revision = ++session.revision;
    return () => this.sessions.get(id) === session && !session.writing && session.revision === revision;
  }

  write<T>(id: string, obsolete: T, task: (ownsSession: () => boolean) => Promise<T>): Promise<T> {
    this.background.get(id)?.abort();
    return this.enqueueWrite(id, obsolete, task);
  }

  async backgroundWrite(id: string, task: (ownsSession: () => boolean, signal: AbortSignal) => Promise<void>) {
    if (this.writes.has(id)) return;
    const controller = new AbortController();
    this.background.set(id, controller);
    try {
      await this.enqueueWrite(id, undefined, (ownsSession) => task(ownsSession, controller.signal));
    } finally {
      if (this.background.get(id) === controller) this.background.delete(id);
    }
  }

  private enqueueWrite<T>(id: string, obsolete: T, task: (ownsSession: () => boolean) => Promise<T>): Promise<T> {
    const session = this.session(id);
    const ownsSession = () => this.sessions.get(id) === session;
    const run = async () => {
      if (!ownsSession()) return obsolete;
      session.writing = true;
      session.revision++;
      try {
        return await task(ownsSession);
      } finally {
        session.writing = false;
        session.revision++;
      }
    };
    const previous = this.writes.get(id);
    const result = (previous ? previous.then(run) : run()).finally(() => {
      if (this.writes.get(id) === tail) this.writes.delete(id);
    });
    const tail = result.then(() => {}, () => {});
    this.writes.set(id, tail);
    return result;
  }
}
