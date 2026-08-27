export interface IceCandidateIdentity {
  candidate?: string;
  usernameFragment?: string | null;
}

/** Keeps late trickle candidates attached to the SDP/ICE generation that made them. */
export class IceGenerationRouter {
  private activeNegotiationId = "";
  private readonly negotiationByUfrag = new Map<string, string>();

  activate(negotiationId: string): void {
    this.activeNegotiationId = negotiationId;
  }

  bindLocalDescription(negotiationId: string, sdp: string): void {
    for (const match of sdp.matchAll(/^a=ice-ufrag:([^\r\n]+)/gmu)) {
      const ufrag = match[1]?.trim();
      if (ufrag) this.negotiationByUfrag.set(ufrag, negotiationId);
    }
    while (this.negotiationByUfrag.size > 16) {
      const oldest = this.negotiationByUfrag.keys().next().value as string | undefined;
      if (!oldest) break;
      this.negotiationByUfrag.delete(oldest);
    }
  }

  negotiationForCandidate(candidate: IceCandidateIdentity): string | undefined {
    const embedded = /(?:^|\s)ufrag\s+([^\s]+)/u.exec(candidate.candidate ?? "")?.[1];
    const ufrag = candidate.usernameFragment || embedded;
    if (!ufrag) return undefined;
    const negotiationId = this.negotiationByUfrag.get(ufrag);
    return negotiationId === this.activeNegotiationId ? negotiationId : undefined;
  }

  reset(): void {
    this.activeNegotiationId = "";
    this.negotiationByUfrag.clear();
  }
}
