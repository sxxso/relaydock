type ReadTicket = { version: number; sequence: number };

export function accountWriteRequest(path: string, method: string) {
  return (
    method !== "GET" &&
    (path === "accounts" ||
      path === "accounts/undo" ||
      path.startsWith("accounts/") ||
      path === "checkin/batch" ||
      path === "map/groups/rename" ||
      path === "backup/import")
  );
}

export class AccountReadState {
  private version = 0;
  private sequence = 0;
  private writes = 0;

  beginRead(): ReadTicket {
    return { version: this.version, sequence: ++this.sequence };
  }
  /** Both edges invalidate GETs; writes can overlap and finally must release once. */
  beginWrite() {
    this.version++;
    this.writes++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.version++;
      this.writes--;
    };
  }
  canApply(ticket: ReadTicket) {
    return (
      this.writes === 0 &&
      ticket.version === this.version &&
      ticket.sequence === this.sequence
    );
  }
}

