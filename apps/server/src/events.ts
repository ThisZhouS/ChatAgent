import type { NativeEvent } from '@chatagent/contracts';

export type NativeEventListener = (event: NativeEvent) => void;

export type Subscription =
  | { ok: true; unsubscribe: () => void }
  | { ok: false; reason: 'subscriber_limit' | 'per_principal_limit' };

export interface NativeEventHubOptions {
  maxSubscribers?: number;
  maxSubscribersPerPrincipal?: number;
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

  constructor(options: NativeEventHubOptions = {}) {
    this.maxSubscribers = options.maxSubscribers ?? 200;
    this.maxSubscribersPerPrincipal = options.maxSubscribersPerPrincipal ?? 5;
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
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not break the request that published.
      }
    }
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
