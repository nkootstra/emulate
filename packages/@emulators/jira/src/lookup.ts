import type { JiraStore } from "./store.js";
import { JiraError, issueNotFound } from "./context.js";

const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const asId = (ref: string | number) => (/^\d+$/.test(String(ref)) ? Number(ref) : undefined);

export function findProject(js: JiraStore, ref: string | number | undefined | null) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  if (id !== undefined) return js.projects.get(id);
  return js.projects.all().find((project) => eqi(project.key, String(ref)));
}

export function requireProject(js: JiraStore, ref: string) {
  const project = findProject(js, ref);
  if (!project) throw new JiraError(404, [`No project could be found with key '${ref}'.`]);
  return project;
}

export function findIssue(js: JiraStore, ref: string | number | undefined | null) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  if (id !== undefined) return js.issues.get(id);
  return js.issues.all().find((issue) => eqi(issue.key, String(ref)));
}

export function requireIssue(js: JiraStore, ref: string) {
  const issue = findIssue(js, ref);
  if (!issue) throw issueNotFound();
  return issue;
}

export function findUser(js: JiraStore, ref: string | undefined | null) {
  if (!ref) return undefined;
  return (
    js.users.findOneBy("account_id", ref) ??
    js.users.all().find((user) => eqi(user.email, ref) || eqi(user.display_name, ref))
  );
}

export function findIssueType(js: JiraStore, ref: string | number | undefined | null) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  if (id !== undefined) return js.issueTypes.get(id);
  return js.issueTypes.all().find((type) => eqi(type.name, String(ref)));
}

export function findStatus(js: JiraStore, ref: string | number | undefined | null) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  if (id !== undefined) return js.statuses.get(id);
  return js.statuses.all().find((status) => eqi(status.name, String(ref)));
}

export function findPriority(js: JiraStore, ref: string | number | undefined | null) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  if (id !== undefined) return js.priorities.get(id);
  return js.priorities.all().find((priority) => eqi(priority.name, String(ref)));
}

export function findResolution(js: JiraStore, ref: string | number | undefined | null) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  if (id !== undefined) return js.resolutions.get(id);
  return js.resolutions.all().find((resolution) => eqi(resolution.name, String(ref)));
}

export function findComponent(js: JiraStore, projectId: number, ref: { id?: string | number; name?: string }) {
  const components = js.components.findBy("project_id", projectId);
  if (ref.id !== undefined) return components.find((component) => component.id === Number(ref.id));
  if (ref.name) return components.find((component) => eqi(component.name, ref.name!));
  return undefined;
}

export function findVersion(js: JiraStore, projectId: number, ref: { id?: string | number; name?: string }) {
  const versions = js.versions.findBy("project_id", projectId);
  if (ref.id !== undefined) return versions.find((version) => version.id === Number(ref.id));
  if (ref.name) return versions.find((version) => eqi(version.name, ref.name!));
  return undefined;
}

export function paginate<T>(items: T[], startAt: number, maxResults: number) {
  const values = items.slice(startAt, startAt + maxResults);
  return {
    startAt,
    maxResults,
    total: items.length,
    isLast: startAt + values.length >= items.length,
    values,
  };
}
