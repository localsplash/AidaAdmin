# Handset-free agent testing

An administrator observes text in Live operations while a caller uses an ordinary
telephone. No AidaHandset installation or device enrollment is involved.

Missing native admission/bootstrap implementation is tracked in
[OfficePulse #18](https://github.com/localsplash/OfficePulseAidaIntegration/issues/18).
AidaAdmin #37 remains open until its real-call acceptance is recorded.

## Prerequisites

- Identity sign-in with current enabled Tenant Admin membership; Super Admins
  explicitly select the intended business first. Observer access never honors
  `tenant=all` or a tenant override and requires a recorded call in that business.
- Configure a development telephone number in Numbers for the intended business
  and verify its effective PBX route, disclosure, queue and fallback with the PBX
  operator. Use that number from the private deployment inventory; no real DID,
  credentials or private infrastructure addresses belong in this document.
- Deploy matching OfficePulse and AidaAgent revisions implementing Agent's
  `docs/BOOTSTRAP_CONTRACT.md` v1. Verify one-time bootstrap/route credentials,
  SIP-leg binding and native admission, plus the verified agent participant SID
  in the call record. A room allocation or healthy process is insufficient.
- Enable the configured Agent worker (preview mode never registers a worker).
  Confirm the actual STT/LLM/TTS/voice configuration and LiveKit dispatch name.
- Configure Admin server `LIVEKIT_URL` (`wss://`), `LIVEKIT_API_KEY` and
  `LIVEKIT_API_SECRET` using protected environment or PlatformConfig. They must
  refer to the call's LiveKit project. Never use VITE variables for secrets.

## Ordinary telephone acceptance

1. Sign in to Admin and select the correct business. Open Live operations.
2. From an ordinary telephone, dial the configured development number. Follow
   the configured queue timing/disclosure. Record the call ID from Admin details;
   correlate it with PBX linkedid through authorized operations diagnostics.
3. Expect arrival only when a call record exists. A bootstrapped event means
   bootstrap progress, not agent speech. Room assignment is not independently
   confirmed admission; a bound participant alone is not confirmed conversation.
4. Select **Observe live transcript**. Expect Connected, without microphone,
   camera or audio permissions. Say a short test question. Expect Caller partials
   updating in place, then final text, and Assistant final text. Hear a relevant
   spoken response on the telephone. Assistant text represents committed text;
   only the caller can confirm audible playback.
5. Interrupt a long response with another question. Verify audible barge-in and
   the new Caller/Assistant turns; text alone cannot prove playback interruption.
6. Open call details, disconnect/reconnect the observer network, and join from a
   second authorized browser. Expect explicit connection status and only newly
   delivered speech. Missing speech during gaps is not replayed. Hang up; expect
   ended status on refreshed details and the call in Recent calls.
7. Verify the other tenant cannot obtain credentials for this call (404), staff
   cannot observe (403), and anonymous/invalid-CSRF requests are rejected.
   Super Admin without selected tenant must be rejected; select the other
   business and confirm the call remains inaccessible. Revoke membership and
   verify credential renewal is denied and the UI clears its text.
8. With the PBX operator, test unavailable bootstrap and failed agent startup.
   Expect explicit unavailable/failure evidence and supported PBX fallback.
   Verify callers can still reach the configured destination; do not infer that
   from a successful Admin build or a dependency health response.

## Connection and privacy contract

The BFF issues 60-second, room-scoped JWTs after fresh Identity membership checks.
Grants prohibit track subscription, media/data publication and metadata changes;
no room administration, SIP or call-control grant is issued. The browser also
connects with autoSubscribe=false and only accepts the `transcript` topic from
the call's bound agent SID with a matching call ID.

LiveKit token expiry gates initial joins, not a hard session lifetime. The UI
reconnects through BFF authorization each minute. A hostile modified client may
retain an established LiveKit session; immediate infrastructure revocation needs
server-side participant removal/token revocation, not JWT expiry alone. See
[LiveKit token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/).

The transcript is browser memory only (200 segments, bounded packet/text sizes).
Partials update by stream/speaker/segment, duplicate and stale revisions are
ignored, and finals cannot regress. Leaving/stopping clears text. Reconnecting
retains only this page's received segments; neither late join nor reconnect
provides historical replay. No transcript database or content logging is added.

## Diagnosing by call ID

Use call details for durable events, room/participant binding and completion.
Use Runtime dependency diagnostics for unavailable OfficePulse/LiveKit/Agent
integration; an unavailable query must not be read as zero calls or zero errors.
If a real call never creates a record, use OfficePulse/PBX linkedid diagnostics:
Admin cannot invent call arrival before the owning service records it.

Record sanitized revision IDs, test outcomes and pseudonymous call correlation
in the acceptance report. Keep telephone numbers, tokens, prompt content and
private host details out of issue/PR examples. Native history/recordings and
broader PBX acceptance remain AidaAdmin #29.
