import type { Store } from "@emulators/core";
import type { AdfNode, JiraChangelog, JiraChangelogItem, JiraComment, JiraIssue, JiraUser } from "./entities.js";
import { JiraError, fieldError } from "./context.js";
import { isAdfDoc, textToAdf, adfToText } from "./adf.js";
import {
  findComponent,
  findIssue,
  findIssueType,
  findPriority,
  findProject,
  findResolution,
  findUser,
  findVersion,
} from "./lookup.js";
import { insertFrom, type JiraStore } from "./store.js";
import { touchIssue } from "./services.js";
import { issueTransitions } from "./issue-format.js";
import type { Fmt } from "./formatters.js";

export interface Actor extends Fmt {
  store: Store;
  user: JiraUser;
}

const NOT_SETTABLE = (field: string) =>
  fieldError(field, `Field '${field}' cannot be set. It is not on the appropriate screen, or unknown.`);

type RefValue = { id?: string | number; key?: string; name?: string; accountId?: string; value?: string } | null;

export function readBody(actor: Pick<Actor, "version">, field: string, value: unknown): AdfNode | null {
  if (value === null || value === undefined || value === "") return null;
  if (actor.version === "2") {
    if (typeof value === "string") return textToAdf(value);
    if (isAdfDoc(value)) return value;
    throw fieldError(field, `The value for ${field} must be a string.`);
  }
  if (!isAdfDoc(value)) {
    throw fieldError(field, "Operation value must be an Atlassian Document (see the Atlassian Document Format)");
  }
  return value;
}

function refOf(value: unknown): RefValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number") return { id: value, name: String(value) };
  if (typeof value === "object") return value as RefValue;
  return {};
}

function resolveUserRef(js: JiraStore, field: string, value: unknown): string | null {
  const ref = refOf(value);
  if (ref === null) return null;
  const key = ref.accountId ?? (ref.id !== undefined ? String(ref.id) : undefined) ?? ref.name;
  if (key === undefined || key === null) return null;
  if (key === "-1") return null;
  const user = findUser(js, key);
  if (!user) throw fieldError(field, `Specify a valid value for ${field}`);
  return user.account_id;
}

function validateParent(js: JiraStore, draft: JiraIssue, parentId: number | null): void {
  const type = js.issueTypes.get(draft.issue_type_id);
  if (parentId === null) {
    if (type?.subtask) throw fieldError("parent", "Subtasks must have a parent issue.");
    return;
  }
  const parent = js.issues.get(parentId);
  if (!parent) throw fieldError("parent", "Could not find the parent issue.");
  if (parent.id === draft.id) throw fieldError("parent", "An issue cannot be its own parent.");
  const parentType = js.issueTypes.get(parent.issue_type_id);
  if (!type || !parentType || parentType.hierarchy_level !== type.hierarchy_level + 1) {
    throw fieldError("parent", "Given parent work item does not belong to appropriate hierarchy.");
  }
  if (type.subtask && parent.project_id !== draft.project_id) {
    throw fieldError("parent", "Subtasks must be in the same project as their parent.");
  }
}

/** Applies one `fields` entry to a draft issue, validating the value. */
export function setField(actor: Actor, draft: JiraIssue, field: string, value: unknown, mode: "create" | "edit"): void {
  const js = actor.js;
  switch (field) {
    case "project":
    case "issuetype":
      if (mode === "edit" && field === "project") throw NOT_SETTABLE(field);
      if (field === "issuetype") {
        const ref = refOf(value);
        const type = ref ? findIssueType(js, ref.id ?? ref.name) : undefined;
        const project = js.projects.get(draft.project_id);
        if (!type || !project?.issue_type_ids.includes(type.id)) {
          throw fieldError("issuetype", "Specify a valid issue type");
        }
        draft.issue_type_id = type.id;
      }
      return;
    case "summary": {
      const summary = typeof value === "string" ? value.trim() : "";
      if (!summary) throw fieldError("summary", "You must specify a summary of the issue.");
      if (summary.length > 255) throw fieldError("summary", "Summary must be less than 255 characters.");
      draft.summary = summary;
      return;
    }
    case "description":
    case "environment":
      draft[field] = readBody(actor, field, value);
      return;
    case "priority": {
      const ref = refOf(value);
      if (ref === null) {
        draft.priority_id = null;
        return;
      }
      const priority = findPriority(js, ref.id ?? ref.name);
      if (!priority) throw fieldError("priority", `Specify a valid value for priority`);
      draft.priority_id = priority.id;
      return;
    }
    case "assignee":
    case "reporter":
      draft[field === "assignee" ? "assignee_id" : "reporter_id"] = resolveUserRef(js, field, value);
      return;
    case "labels": {
      const labels = Array.isArray(value) ? value : value == null ? [] : null;
      if (!labels) throw fieldError("labels", "The labels field must be an array of strings.");
      draft.labels = labels.map((label) => validateLabel(String(label)));
      return;
    }
    case "duedate":
      if (value !== null && value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        throw fieldError("duedate", "Error parsing date string: " + String(value));
      }
      draft.due_date = value ? String(value) : null;
      return;
    case "parent": {
      const ref = refOf(value);
      const parent = ref ? findIssue(js, ref.key ?? ref.id) : null;
      if (ref && !parent) throw fieldError("parent", "Could not find the parent issue.");
      draft.parent_id = parent?.id ?? null;
      return;
    }
    case "components":
    case "fixVersions": {
      if (!Array.isArray(value)) throw fieldError(field, `Field ${field} must be an array.`);
      draft[field === "components" ? "component_ids" : "fix_version_ids"] = value.map((entry) =>
        resolveProjectItem(actor, draft, field, entry),
      );
      return;
    }
    case "resolution": {
      const ref = refOf(value);
      if (ref === null) {
        draft.resolution_id = null;
        draft.resolution_date = null;
        return;
      }
      const resolution = findResolution(js, ref.id ?? ref.name);
      if (!resolution) throw fieldError("resolution", "Specify a valid value for resolution");
      if (!draft.resolution_id) draft.resolution_date = new Date().toISOString();
      draft.resolution_id = resolution.id;
      return;
    }
    case "status":
      throw NOT_SETTABLE("status");
    default:
      setCustomField(actor, draft, field, value);
  }
}

function validateLabel(label: string): string {
  if (/\s/.test(label)) throw fieldError("labels", `The label '${label}' contains spaces which is invalid.`);
  if (label.length > 255) throw fieldError("labels", "The label must not exceed 255 characters.");
  return label;
}

function resolveProjectItem(actor: Actor, draft: JiraIssue, field: string, entry: unknown): number {
  const ref = refOf(entry) ?? {};
  const find = field === "components" ? findComponent : findVersion;
  const item = find(actor.js, draft.project_id, { id: ref.id, name: ref.name });
  if (!item) {
    const label = field === "components" ? "Component" : "Version";
    throw fieldError(field, `${label} name '${ref.name ?? ref.id}' is not valid`);
  }
  return item.id;
}

function setCustomField(actor: Actor, draft: JiraIssue, field: string, value: unknown): void {
  const def = actor.js.customFields.findOneBy("field_id", field);
  if (!def) throw NOT_SETTABLE(field);
  if (value === null || value === undefined) {
    if (def.type === "sprint") draft.sprint_id = null;
    else draft.custom_fields = { ...draft.custom_fields, [field]: null };
    return;
  }
  const invalid = () =>
    fieldError(field, `Operation value must be a ${def.type === "number" ? "number" : "valid value"}`);
  let stored: unknown = value;
  switch (def.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
      break;
    case "string":
      if (typeof value !== "string") throw invalid();
      break;
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid();
      break;
    case "datetime":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw invalid();
      break;
    case "array":
      if (!Array.isArray(value)) throw invalid();
      stored = value.map(String);
      break;
    case "option": {
      const option = typeof value === "string" ? value : (value as { value?: string }).value;
      if (!option || (def.options.length > 0 && !def.options.includes(option))) throw invalid();
      stored = option;
      break;
    }
    case "user":
      stored = resolveUserRef(actor.js, field, value);
      break;
    case "sprint": {
      const sprintId = typeof value === "number" ? value : Number((value as { id?: number }).id ?? value);
      const sprint = actor.js.sprints.get(sprintId);
      if (!sprint) throw fieldError(field, `Sprint with id ${String(value)} does not exist.`);
      if (sprint.state === "closed") throw fieldError(field, "Issue can be assigned only to active or future sprints.");
      draft.sprint_id = sprint.id;
      return;
    }
  }
  draft.custom_fields = { ...draft.custom_fields, [field]: stored };
}

export interface PendingLink {
  typeId: number;
  otherId: number;
  /** True for `outwardIssue`, which makes the edited issue the source ("this issue blocks the other"). */
  issueIsSource: boolean;
}

export interface UpdateSideEffects {
  comments: unknown[];
  links: PendingLink[];
}

/** Applies `update` operations (`set`, `add`, `remove`, `edit`). Comment and link additions are returned for the caller. */
export function applyUpdateOps(
  actor: Actor,
  draft: JiraIssue,
  update: Record<string, unknown>,
  mode: "create" | "edit",
): UpdateSideEffects {
  const effects: UpdateSideEffects = { comments: [], links: [] };
  for (const [field, opsValue] of Object.entries(update ?? {})) {
    if (!Array.isArray(opsValue)) throw fieldError(field, "Field operations must be an array.");
    for (const op of opsValue as Array<Record<string, unknown>>) {
      const [verb, value] = Object.entries(op)[0] ?? [];
      if (field === "comment") {
        if (verb !== "add") throw fieldError("comment", "Only add is supported for comments.");
        effects.comments.push((value as { body?: unknown })?.body);
        continue;
      }
      if (field === "issuelinks") {
        if (verb !== "add") throw fieldError("issuelinks", "Only add is supported for issue links.");
        effects.links.push(resolvePendingLink(actor.js, value as LinkInput));
        continue;
      }
      if (verb === "set" || verb === "edit") {
        setField(actor, draft, field, value, mode);
      } else if (verb === "add" || verb === "remove") {
        applyListOp(actor, draft, field, verb, value);
      } else {
        throw fieldError(field, `Unsupported operation '${verb}' for field ${field}.`);
      }
    }
  }
  return effects;
}

interface LinkInput {
  type?: { id?: string | number; name?: string };
  inwardIssue?: { id?: string | number; key?: string };
  outwardIssue?: { id?: string | number; key?: string };
}

function resolvePendingLink(js: JiraStore, input: LinkInput): PendingLink {
  const type = findLinkType(js, input?.type);
  if (!type) throw fieldError("issuelinks", "No issue link type with name or id specified found.");
  const otherRef = input.outwardIssue ?? input.inwardIssue;
  const other = otherRef ? findIssue(js, otherRef.key ?? otherRef.id) : undefined;
  if (!other) throw fieldError("issuelinks", "The linked issue does not exist.");
  return { typeId: type.id, otherId: other.id, issueIsSource: Boolean(input.outwardIssue) };
}

export function findLinkType(js: JiraStore, ref: { id?: string | number; name?: string } | undefined) {
  if (!ref) return undefined;
  if (ref.id !== undefined) return js.issueLinkTypes.get(Number(ref.id));
  return js.issueLinkTypes.all().find((type) => type.name.toLowerCase() === String(ref.name ?? "").toLowerCase());
}

export function createLink(js: JiraStore, typeId: number, inwardId: number, outwardId: number) {
  const existing = js.issueLinks
    .findBy("inward_issue_id", inwardId)
    .find((link) => link.outward_issue_id === outwardId && link.type_id === typeId);
  if (existing) return existing;
  const link = insertFrom(js.issueLinks, 10000, {
    type_id: typeId,
    inward_issue_id: inwardId,
    outward_issue_id: outwardId,
  });
  touchIssue(js, inwardId);
  touchIssue(js, outwardId);
  return link;
}

function applyLinks(js: JiraStore, issue: JiraIssue, links: PendingLink[]): void {
  for (const link of links) {
    if (link.issueIsSource) createLink(js, link.typeId, link.otherId, issue.id);
    else createLink(js, link.typeId, issue.id, link.otherId);
  }
}

function applyListOp(actor: Actor, draft: JiraIssue, field: string, verb: "add" | "remove", value: unknown): void {
  if (field === "labels") {
    const label = validateLabel(String(value));
    draft.labels =
      verb === "add"
        ? draft.labels.includes(label)
          ? draft.labels
          : [...draft.labels, label]
        : draft.labels.filter((existing) => existing !== label);
    return;
  }
  if (field === "components" || field === "fixVersions") {
    const key = field === "components" ? "component_ids" : "fix_version_ids";
    const id = resolveProjectItem(actor, draft, field, value);
    draft[key] = verb === "add" ? [...new Set([...draft[key], id])] : draft[key].filter((existing) => existing !== id);
    return;
  }
  const def = actor.js.customFields.findOneBy("field_id", field);
  if (def?.type === "array") {
    const current = (draft.custom_fields[field] as string[] | null) ?? [];
    const item = String(value);
    const next = verb === "add" ? [...new Set([...current, item])] : current.filter((existing) => existing !== item);
    draft.custom_fields = { ...draft.custom_fields, [field]: next };
    return;
  }
  throw fieldError(field, `Field '${field}' does not support the ${verb} operation.`);
}

export interface CreateIssueResult {
  issue: JiraIssue;
  comments: JiraComment[];
}

export function createIssue(
  actor: Actor,
  body: { fields?: Record<string, unknown>; update?: Record<string, unknown> },
): CreateIssueResult {
  const js = actor.js;
  const fields = body?.fields ?? {};
  const projectRef = refOf(fields.project);
  const project = projectRef ? findProject(js, projectRef.key ?? projectRef.id) : undefined;
  if (!project) throw fieldError("project", "Specify a valid project ID or key");
  if (fields.issuetype === undefined) throw fieldError("issuetype", "Specify an issue type");
  if (fields.summary === undefined && !hasSetOp(body.update, "summary")) {
    throw fieldError("summary", "You must specify a summary of the issue.");
  }

  const initial = js.statuses.get(project.status_ids[0]);
  if (!initial) throw new JiraError(400, ["The project has no workflow statuses."]);
  const now = new Date().toISOString();
  const draft: JiraIssue = {
    id: 0,
    created_at: now,
    updated_at: now,
    key: "",
    number: 0,
    project_id: project.id,
    issue_type_id: 0,
    summary: "",
    description: null,
    environment: null,
    status_id: initial.id,
    status_changed_at: now,
    priority_id: js.priorities.findOneBy("name", "Medium")?.id ?? null,
    resolution_id: null,
    resolution_date: null,
    assignee_id: null,
    reporter_id: actor.user.account_id,
    creator_id: actor.user.account_id,
    parent_id: null,
    labels: [],
    component_ids: [],
    fix_version_ids: [],
    due_date: null,
    custom_fields: {},
    watcher_ids: [actor.user.account_id],
    sprint_id: null,
    closed_sprint_ids: [],
  };

  const ordered = ["issuetype", ...Object.keys(fields).filter((key) => key !== "issuetype" && key !== "project")];
  for (const field of ordered) setField(actor, draft, field, fields[field], "create");
  const effects = applyUpdateOps(actor, draft, body.update ?? {}, "create");
  validateParent(js, draft, draft.parent_id);
  if (initial.category === "done" && !draft.resolution_id) {
    draft.resolution_id = js.resolutions.all()[0]?.id ?? null;
    draft.resolution_date = draft.resolution_id ? now : null;
  }

  const comments = effects.comments.map((raw) => readBody(actor, "comment", raw)!);
  const number = project.issue_sequence + 1;
  js.projects.update(project.id, { issue_sequence: number });
  const { id: _id, created_at: _c, updated_at: _u, ...data } = draft;
  const issue = insertFrom(js.issues, 10000, { ...data, key: `${project.key}-${number}`, number });
  applyLinks(js, issue, effects.links);
  return { issue, comments: comments.map((body) => addComment(actor, issue, body)) };
}

function hasSetOp(update: Record<string, unknown> | undefined, field: string): boolean {
  const ops = update?.[field];
  return Array.isArray(ops) && ops.some((op) => op && typeof op === "object" && "set" in op);
}

export function addComment(actor: Actor, issue: JiraIssue, body: AdfNode): JiraComment {
  const comment = insertFrom(actor.js.comments, 10000, {
    issue_id: issue.id,
    author_id: actor.user.account_id,
    update_author_id: actor.user.account_id,
    body,
  });
  touchIssue(actor.js, issue.id);
  return comment;
}

export interface EditIssueResult {
  issue: JiraIssue;
  items: JiraChangelogItem[];
  changelog: JiraChangelog | null;
  comments: JiraComment[];
}

/** Edits an issue from `fields` and `update`, then records a changelog entry for what changed. */
export function editIssue(
  actor: Actor,
  issue: JiraIssue,
  body: { fields?: Record<string, unknown>; update?: Record<string, unknown> },
  extra?: (draft: JiraIssue) => void,
): EditIssueResult {
  const draft: JiraIssue = structuredClone(issue);
  for (const [field, value] of Object.entries(body?.fields ?? {})) setField(actor, draft, field, value, "edit");
  const effects = applyUpdateOps(actor, draft, body?.update ?? {}, "edit");
  extra?.(draft);
  if (draft.parent_id !== issue.parent_id || draft.issue_type_id !== issue.issue_type_id) {
    validateParent(actor.js, draft, draft.parent_id);
  }
  const comments = effects.comments.map((raw) => readBody(actor, "comment", raw)!);

  const items = diffIssues(actor.js, issue, draft);
  let updated = issue;
  let changelog: JiraChangelog | null = null;
  if (items.length > 0) {
    const { id: _id, created_at: _c, updated_at: _u, ...data } = draft;
    updated = actor.js.issues.update(issue.id, data)!;
    changelog = insertFrom(actor.js.changelogs, 10000, { issue_id: issue.id, author_id: actor.user.account_id, items });
  }
  applyLinks(actor.js, updated, effects.links);
  const added = comments.map((commentBody) => addComment(actor, updated, commentBody));
  return { issue: actor.js.issues.get(issue.id)!, items, changelog, comments: added };
}

export function transitionIssue(
  actor: Actor,
  issue: JiraIssue,
  body: { transition?: { id?: string | number }; fields?: Record<string, unknown>; update?: Record<string, unknown> },
): EditIssueResult {
  const transitionId = String(body?.transition?.id ?? "");
  const transition = issueTransitions(actor, issue).find((entry) => entry.id === transitionId);
  if (!transition) throw new JiraError(400, [`Transition id '${transitionId}' is not valid for this issue.`]);
  const target = transition.status;
  const fields = { ...(body.fields ?? {}) };
  const explicitResolution = "resolution" in fields;
  return editIssue(actor, issue, { fields, update: body.update }, (draft) => {
    draft.status_id = target.id;
    draft.status_changed_at = new Date().toISOString();
    if (target.category === "done") {
      if (!draft.resolution_id && !explicitResolution) {
        draft.resolution_id =
          actor.js.resolutions.findOneBy("name", "Done")?.id ?? actor.js.resolutions.all()[0]?.id ?? null;
      }
      draft.resolution_date ??= new Date().toISOString();
    } else {
      draft.resolution_id = null;
      draft.resolution_date = null;
    }
  });
}

function joinNames<T>(ids: T[], lookup: (id: T) => string | undefined): string | null {
  const names = ids.map(lookup).filter(Boolean);
  return names.length > 0 ? names.join(" ") : null;
}

/** Builds Jira style changelog items for every tracked field that differs between two issue states. */
export function diffIssues(js: JiraStore, before: JiraIssue, after: JiraIssue): JiraChangelogItem[] {
  const items: JiraChangelogItem[] = [];
  const push = (
    field: string,
    fieldId: string,
    from: string | null,
    fromString: string | null,
    to: string | null,
    toString: string | null,
    fieldtype: "jira" | "custom" = "jira",
  ) => {
    if (from === to && fromString === toString) return;
    items.push({ field, fieldtype, fieldId, from, fromString, to, toString });
  };
  const str = (value: number | null) => (value === null ? null : String(value));
  const user = (id: string | null) => (id ? (js.users.findOneBy("account_id", id)?.display_name ?? id) : null);

  push("summary", "summary", null, before.summary, null, after.summary);
  const beforeDescription = before.description ? adfToText(before.description) : null;
  const afterDescription = after.description ? adfToText(after.description) : null;
  if (JSON.stringify(before.description) !== JSON.stringify(after.description)) {
    items.push({
      field: "description",
      fieldtype: "jira",
      fieldId: "description",
      from: null,
      fromString: beforeDescription,
      to: null,
      toString: afterDescription,
    });
  }
  if (JSON.stringify(before.environment) !== JSON.stringify(after.environment)) {
    items.push({
      field: "environment",
      fieldtype: "jira",
      fieldId: "environment",
      from: null,
      fromString: before.environment ? adfToText(before.environment) : null,
      to: null,
      toString: after.environment ? adfToText(after.environment) : null,
    });
  }
  push(
    "issuetype",
    "issuetype",
    str(before.issue_type_id),
    js.issueTypes.get(before.issue_type_id)?.name ?? null,
    str(after.issue_type_id),
    js.issueTypes.get(after.issue_type_id)?.name ?? null,
  );
  push(
    "status",
    "status",
    str(before.status_id),
    js.statuses.get(before.status_id)?.name ?? null,
    str(after.status_id),
    js.statuses.get(after.status_id)?.name ?? null,
  );
  push(
    "priority",
    "priority",
    str(before.priority_id),
    before.priority_id ? (js.priorities.get(before.priority_id)?.name ?? null) : null,
    str(after.priority_id),
    after.priority_id ? (js.priorities.get(after.priority_id)?.name ?? null) : null,
  );
  push(
    "resolution",
    "resolution",
    str(before.resolution_id),
    before.resolution_id ? (js.resolutions.get(before.resolution_id)?.name ?? null) : null,
    str(after.resolution_id),
    after.resolution_id ? (js.resolutions.get(after.resolution_id)?.name ?? null) : null,
  );
  push(
    "assignee",
    "assignee",
    before.assignee_id,
    user(before.assignee_id),
    after.assignee_id,
    user(after.assignee_id),
  );
  push(
    "reporter",
    "reporter",
    before.reporter_id,
    user(before.reporter_id),
    after.reporter_id,
    user(after.reporter_id),
  );
  push("duedate", "duedate", before.due_date, before.due_date, after.due_date, after.due_date);
  if (before.labels.join(" ") !== after.labels.join(" ")) {
    push("labels", "labels", null, before.labels.join(" ") || null, null, after.labels.join(" ") || null);
  }
  push(
    "IssueParentAssociation",
    "parent",
    str(before.parent_id),
    before.parent_id ? (js.issues.get(before.parent_id)?.key ?? null) : null,
    str(after.parent_id),
    after.parent_id ? (js.issues.get(after.parent_id)?.key ?? null) : null,
  );
  if (before.component_ids.join(",") !== after.component_ids.join(",")) {
    push(
      "Component",
      "components",
      before.component_ids.join(",") || null,
      joinNames(before.component_ids, (id) => js.components.get(id)?.name),
      after.component_ids.join(",") || null,
      joinNames(after.component_ids, (id) => js.components.get(id)?.name),
    );
  }
  if (before.fix_version_ids.join(",") !== after.fix_version_ids.join(",")) {
    push(
      "Fix Version",
      "fixVersions",
      before.fix_version_ids.join(",") || null,
      joinNames(before.fix_version_ids, (id) => js.versions.get(id)?.name),
      after.fix_version_ids.join(",") || null,
      joinNames(after.fix_version_ids, (id) => js.versions.get(id)?.name),
    );
  }
  if (before.sprint_id !== after.sprint_id) {
    const sprintField = js.customFields.all().find((field) => field.type === "sprint");
    push(
      sprintField?.name ?? "Sprint",
      sprintField?.field_id ?? "customfield_10020",
      str(before.sprint_id),
      before.sprint_id ? (js.sprints.get(before.sprint_id)?.name ?? null) : null,
      str(after.sprint_id),
      after.sprint_id ? (js.sprints.get(after.sprint_id)?.name ?? null) : null,
      "custom",
    );
  }
  for (const field of js.customFields.all()) {
    if (field.type === "sprint") continue;
    const from = before.custom_fields[field.field_id] ?? null;
    const to = after.custom_fields[field.field_id] ?? null;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    const text = (value: unknown) =>
      value === null
        ? null
        : field.type === "user"
          ? user(String(value))
          : Array.isArray(value)
            ? value.join(" ")
            : String(value);
    push(field.name, field.field_id, null, text(from), null, text(to), "custom");
  }
  return items;
}

/** Actor used when seeding data outside of a request. */
export function systemActor(store: Store, js: JiraStore, baseUrl: string, user: JiraUser): Actor {
  return { store, js, baseUrl, siteUrl: baseUrl, version: "3", user };
}
