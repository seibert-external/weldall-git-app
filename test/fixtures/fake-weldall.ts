import { WeldallAuthError } from "@weldall/sdk";
import {
  appHostAuditEventRequestSchema,
  type AppHostAuditEventRequest,
} from "../../src/app-host.js";
import type { AppHostApi } from "../../src/weldall.js";

/**
 * In-process fake of Weldall's app host API, implementing the contract in
 * `src/app-host.ts`: every request is validated against the contract's request schemas
 * (with the resource added, as the real client does), audit rules follow the contract header,
 * and every call is recorded. No network. Weldall keeps no app records: the registry is the Git
 * app's own database.
 */
export function createFakeWeldall({
  resource,
  people,
}: {
  resource: string;
  /** Weldall user id → scopes the person holds right now. */
  people: Record<string, string[]>;
}) {
  const events: Array<AppHostAuditEventRequest & { auditEventId: string }> = [];
  const calls: Array<{ method: keyof AppHostApi; input: unknown }> = [];
  /** Errors thrown by the next calls of a method, in order. */
  const failures = new Map<keyof AppHostApi, unknown[]>();
  let nextId = 1;

  const record = (method: keyof AppHostApi, input: unknown) => {
    calls.push({ method, input });
    const queued = failures.get(method);
    if (queued?.length) throw queued.shift();
  };
  const knownSubject = (subject: string) => {
    if (!(subject in people)) throw new WeldallAuthError("unknown_subject", "unknown", 404);
  };
  const invalid = (message: string) => new WeldallAuthError("invalid_request", message, 400);

  const api: AppHostApi = {
    async reportAuditEvent(input) {
      record("reportAuditEvent", input);
      const parsed = appHostAuditEventRequestSchema.safeParse({ ...input, resource });
      if (!parsed.success) throw invalid(parsed.error.message);
      const report = parsed.data;
      const duplicate = events.find(({ eventId }) => eventId === report.eventId);
      if (duplicate) {
        const { auditEventId, ...stored } = duplicate;
        if (JSON.stringify(stored) !== JSON.stringify(report))
          throw new WeldallAuthError("event_id_conflict", "conflict", 409);
        return {
          accepted: true,
          eventId: report.eventId,
          auditEventId,
          duplicate: true,
          recordedAt: new Date().toISOString(),
        };
      }
      if (report.subject !== null) knownSubject(report.subject);
      const auditEventId = `audit-${events.length + 1}`;
      events.push({ ...report, auditEventId });
      return {
        accepted: true,
        eventId: report.eventId,
        auditEventId,
        duplicate: false,
        recordedAt: new Date().toISOString(),
      };
    },
    async checkSubjectScopes(subject, scopes) {
      record("checkSubjectScopes", { subject, scopes });
      // As Weldall's subject scope check (`apps/weldall/src/server/oauth/subject-scopes-api.ts` in
      // the Weldall repository): an unknown user is 404 not_found.
      if (!(subject in people))
        throw new WeldallAuthError("not_found", "subject was not found", 404);
      const held = people[subject]!;
      return {
        granted: scopes.filter((scope) => held.includes(scope)).sort(),
        missing: scopes.filter((scope) => !held.includes(scope)).sort(),
        evaluatedAt: new Date().toISOString(),
      };
    },
  };

  return {
    api,
    events,
    calls,
    /** Makes the next calls of `method` throw `errors`, in order. */
    fail(method: keyof AppHostApi, ...errors: unknown[]) {
      failures.set(method, [...(failures.get(method) ?? []), ...errors]);
    },
    callsOf: (method: keyof AppHostApi) =>
      calls.filter((call) => call.method === method).map(({ input }) => input),
  };
}
export type FakeWeldall = ReturnType<typeof createFakeWeldall>;
