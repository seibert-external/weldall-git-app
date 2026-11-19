import type { AuditReporter } from "../audit.js";
import type { ConfiguredHost } from "../hosts/index.js";
import type { Logger } from "../log.js";
import type { AppRegistry } from "../registry/registry.js";
import type { AppHostApi } from "../weldall.js";

/** What every endpoint service works with; built once per instance in `app.ts`. */
export interface GitAppServices {
  host: ConfiguredHost;
  weldall: AppHostApi;
  /** The app registry in the Git app's own database. */
  registry: AppRegistry;
  audit: AuditReporter;
  log: Logger;
  scopes: { publish: string; admin: string; registryRead: string };
}

/**
 * The person a request acts for: the verified token's `sub`, a Weldall user id, and the verified
 * email address the token carries (null where none is known, e.g. the git proxy's credentials).
 */
export interface Person {
  id: string;
  email: string | null;
}
