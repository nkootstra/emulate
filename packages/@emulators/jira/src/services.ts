import type { JiraIssue, JiraProject } from "./entities.js";
import type { JiraStore } from "./store.js";

/** Removes an issue and everything that hangs off it. Subtasks are removed too. */
export function deleteIssueRecord(js: JiraStore, issue: JiraIssue): void {
  for (const child of js.issues.findBy("parent_id", issue.id)) {
    if (js.issueTypes.get(child.issue_type_id)?.subtask) deleteIssueRecord(js, child);
    else js.issues.update(child.id, { parent_id: null });
  }
  for (const comment of js.comments.findBy("issue_id", issue.id)) js.comments.delete(comment.id);
  for (const entry of js.changelogs.findBy("issue_id", issue.id)) js.changelogs.delete(entry.id);
  for (const worklog of js.worklogs.findBy("issue_id", issue.id)) js.worklogs.delete(worklog.id);
  for (const link of [
    ...js.issueLinks.findBy("inward_issue_id", issue.id),
    ...js.issueLinks.findBy("outward_issue_id", issue.id),
  ]) {
    js.issueLinks.delete(link.id);
  }
  js.issues.delete(issue.id);
}

export function deleteProjectRecord(js: JiraStore, project: JiraProject): void {
  for (const issue of js.issues.findBy("project_id", project.id)) {
    if (js.issues.get(issue.id)) deleteIssueRecord(js, issue);
  }
  for (const component of js.components.findBy("project_id", project.id)) js.components.delete(component.id);
  for (const version of js.versions.findBy("project_id", project.id)) js.versions.delete(version.id);
  for (const board of js.boards.findBy("project_id", project.id)) {
    for (const sprint of js.sprints.findBy("board_id", board.id)) js.sprints.delete(sprint.id);
    js.boards.delete(board.id);
  }
  js.projects.delete(project.id);
}
