// A tab can close and reopen at the same path while a native command is running.
// Keep its write queue until it drains, but revoke the old tab's publication rights.
export class RepositoryOperations {
  private sessions = new Map<string, { revision: number; writing: boolean }>();
  private writes = new Map<string, Promise<void>>();

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
  }

  owner(id: string) {
    const session = this.session(id);
    return () => this.sessions.get(id) === session;
  }

  read(id: string) {
    const session = this.session(id);
    const revision = ++session.revision;
    return () => this.sessions.get(id) === session && !session.writing && session.revision === revision;
  }

  write<T>(id: string, obsolete: T, task: (ownsSession: () => boolean) => Promise<T>): Promise<T> {
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
    const result = previous ? previous.then(run) : run();
    const tail = result.then(() => {}, () => {});
    this.writes.set(id, tail);
    void tail.then(() => {
      if (this.writes.get(id) === tail) this.writes.delete(id);
    });
    return result;
  }
}
