import { GitAppError } from "../errors.js";

/**
 * Refuses to register a configured template repository as an app: templates are what new apps
 * start from, and publishing to one would change every later app.
 */
export function refuseTemplate(
  templates: ReadonlyArray<{ repository: string }>,
  organization: string,
  name: string,
): void {
  const full = `${organization}/${name}`.toLowerCase();
  if (templates.some(({ repository }) => repository.toLowerCase() === full))
    throw new GitAppError(
      "repository_is_template",
      `${organization}/${name} is a template repository of this Git app and cannot be registered as an app.`,
      409,
    );
}
