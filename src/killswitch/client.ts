import { timeoutFetch } from "../util/http";

type Fetch = typeof fetch;
export interface KillState {
  killed: boolean;
  /** wave-2 kill hysteresis (audit #3/#6/#9): true ONLY when an HTTP 200
   *  actually said killed:true. A confirmed kill is the restore-everything
   *  signal; an UNCONFIRMED kill (offline fail-safe) must FREEZE instead —
   *  no restore, no new writes — so a wifi blip never starts the
   *  restore→re-patch oscillation on the user's Claude Code install. */
  confirmed: boolean;
  scope?: string;
  reason?: string;
  /** wave-2A-F06: distinguishes a fail-safe "treated as killed because
   *  unreachable" from a real backend killed: true response. Callers can
   *  render an "offline" status (status bar already has the `kind:"offline"`
   *  mode unused pre-fix) instead of the alarming "killed" badge that
   *  used to flicker on every brief network blip. Offline still implies
   *  killed for the purposes of "is it safe to serve an ad" (fail-safe
   *  posture for NEW writes) — but never `confirmed`, so it never restores. */
  offline?: boolean;
}

/** Polls GET /v1/killswitch. Fail-safe: any error => killed (matches the S2
 *  resolve_killed posture — never serve under a kill). When the error was
 *  unreachability rather than a real backend kill, `offline: true` is set
 *  (and `confirmed` stays false) so the caller can FREEZE rather than
 *  restore, and the status bar can render distinct UX. */
export class KillSwitchClient {
  constructor(private base: string, private f: Fetch = timeoutFetch(15000)) {}

  async checkOnce(ccVersion: string, campaignId: string): Promise<KillState> {
    try {
      const r = await this.f(
        `${this.base}/v1/killswitch?version=${encodeURIComponent(ccVersion)}` +
        `&campaign=${encodeURIComponent(campaignId)}`);
      if (!r.ok) {
        // 5xx or 4xx -> offline-equivalent (backend reachable but not
        // returning the contract). Still fail-safe killed, never confirmed.
        return { killed: true, confirmed: false, offline: true,
                 reason: `status ${r.status}` };
      }
      const j = await r.json() as KillState;
      return {
        killed: !!j.killed,
        confirmed: !!j.killed,
        scope: j.scope,
        reason: j.reason,
        offline: false,
      };
    } catch (e) {
      // Network/DNS error -> truly offline. Caller freezes; kill posture
      // preserved for NEW writes only.
      return { killed: true, confirmed: false, offline: true,
               reason: `fail-safe: ${String(e)}` };
    }
  }
}
