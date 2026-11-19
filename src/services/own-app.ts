import { GitAppError } from "../errors.js";
import type { RegistryApp } from "../registry/registry.js";
import type { GitAppServices, Person } from "./context.js";

/**
 * Resolves one of the person's apps from the app registry. An unknown id and another person's app
 * get the same 404, so the answer reveals nothing about other people's apps. The repository must
 * have finished creation and belong to this instance's organisation.
 */
export async function resolveOwnApp(
  services: GitAppServices,
  person: Person,
  appId: string,
  { requireReady = true }: { requireReady?: boolean } = {},
): Promise<RegistryApp> {
  const app = await services.registry.byId(appId);
  if (!app || app.owner.id !== person.id)
    throw new GitAppError("not_found", "No app of yours has this id.", 404);
  if (app.repository.owner.toLowerCase() !== services.host.organization.toLowerCase())
    throw new GitAppError(
      "invalid_target",
      "The app's repository is not in this Git app's organisation.",
      409,
    );
  if (requireReady && !app.ready)
    throw new GitAppError(
      "repository_not_ready",
      "The app's repository is still being created. Retry the app creation first.",
      409,
    );
  return app;
}
