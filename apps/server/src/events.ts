import type { NativeEvent } from '@chatagent/contracts';

/**
 * A published event with its position in the stream. The sequence number is what lets a
 * reconnect ask for "everything after N" instead of silently missing the gap.
 */
export interface SequencedNativeEvent {
  seq: number;
  event: NativeEvent;
}

export type NativeEventListener = (event: NativeEvent, seq: number) => void;

export type Subscription =
  | { ok: true; unsubscribe: () => void }
  | { ok: false; reason: 'subscriber_limit' | 'per_principal_limit' };

export interface NativeEventHubOptions {
  maxSubscribers?: number;
  maxSubscribersPerPrincipal?: number;
  /** Events kept for replay after a reconnect. Bounded: memory, not an audit log. */
  replayBufferSize?: number;
}

/**
 * In-process fan-out for the native client (messages, task and approval
 * updates). Subscribers are responsible for authorizing before emitting.
 *
 * The hub is bounded so a single client cannot exhaust server memory by
 * opening connections: every stream costs one listener plus one socket.
 */
export class NativeEventHub {
  private readonly listeners = new Set<NativeEventListener>();
  private readonly perPrincipal = new Map<string, number>();
  private readonly maxSubscribers: number;
  private readonly maxSubscribersPerPrincipal: number;
  private readonly replayBufferSize: number;
  private readonly recent: SequencedNativeEvent[] = [];
  private sequence = 0;

  constructor(options: NativeEventHubOptions = {}) {
    this.maxSubscribers = options.maxSubscribers ?? 200;
    this.maxSubscribersPerPrincipal = options.maxSubscribersPerPrincipal ?? 5;
    this.replayBufferSize = Math.max(0, options.replayBufferSize ?? 500);
  }

  /** Position of the newest published event (0 before anything was published). */
  get latestSeq(): number {
    return this.sequence;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Principals with at least one open stream. This is the only honest presence
   * signal the server has: it means "a client is connected", not "a human is
   * looking at the screen".
   */
  onlinePrincipals(): string[] {
    return [...this.perPrincipal.keys()].filter((id) => id !== 'anonymous');
  }

  publish(event: NativeEvent): void {
    const seq = (this.sequence += 1);
    if (this.replayBufferSize > 0) {
      this.recent.push({ seq, event });
      // Keep the newest entries only: this is a reconnect buffer, not an audit log.
      if (this.recent.length > this.replayBufferSize) {
        this.recent.splice(0, this.recent.length - this.replayBufferSize);
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event, seq);
      } catch {
        // A broken subscriber must not break the request that published.
      }
    }
  }

  /**
   * Events published after `afterSeq`, oldest first. Callers re-authorize each one before
   * writing it: a reconnect must not become a way to read what the stream would refuse.
   */
  /** The oldest event still held for replay, or undefined when nothing is held. */
  get oldestSeq(): number | undefined {
    return this.recent[0]?.seq;
  }

  /**
   * Events published after `afterSeq`, oldest first, plus whether the request fell off the
   * back of the buffer. That flag matters: returning an empty list for a cursor we can no
   * longer honour tells the client "nothing happened", which is a lie it will believe.
   */
  since(afterSeq: number): { entries: SequencedNativeEvent[]; truncated: boolean } {
    if (!Number.isFinite(afterSeq) || afterSeq < 0) return { entries: [], truncated: false };
    const entries = this.recent.filter((entry) => entry.seq > afterSeq);
    const oldest = this.oldestSeq;
    // Two ways to be out of date: the cursor is older than the buffer, or the buffer is empty
    // while the client claims to have seen events (which means it was reset by a restart).
    const truncated = oldest !== undefined ? afterSeq < oldest - 1 : afterSeq > 0;
    return { entries, truncated };
  }

  subscribe(listener: NativeEventListener, principalId = 'anonymous'): Subscription {
    if (this.listeners.size >= this.maxSubscribers) {
      return { ok: false, reason: 'subscriber_limit' };
    }
    const current = this.perPrincipal.get(principalId) ?? 0;
    if (current >= this.maxSubscribersPerPrincipal) {
      return { ok: false, reason: 'per_principal_limit' };
    }

    this.listeners.add(listener);
    this.perPrincipal.set(principalId, current + 1);

    return {
      ok: true,
      unsubscribe: () => {
        this.listeners.delete(listener);
        const remaining = (this.perPrincipal.get(principalId) ?? 1) - 1;
        if (remaining <= 0) this.perPrincipal.delete(principalId);
        else this.perPrincipal.set(principalId, remaining);
      },
    };
  }
}


/** Caps concurrent long-lived streams (SSE) per principal. */
export class StreamLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxPerPrincipal = 8) {}

  acquire(principalId: string): boolean {
    const current = this.counts.get(principalId) ?? 0;
    if (current >= this.maxPerPrincipal) return false;
    this.counts.set(principalId, current + 1);
    return true;
  }

  release(principalId: string): void {
    const current = (this.counts.get(principalId) ?? 1) - 1;
    if (current <= 0) this.counts.delete(principalId);
    else this.counts.set(principalId, current);
  }
}
