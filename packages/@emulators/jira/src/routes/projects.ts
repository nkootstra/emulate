import type { RouteContext } from "@emulators/core";
import { JiraError, fieldError, intParam, listParam, makeHandler, readJson, type JiraRequest } from "../context.js";
import { formatComponent, formatProject, formatVersion, restUrl } from "../formatters.js";
import { findProject, findUser, paginate, requireProject } from "../lookup.js";
import { insertFrom } from "../store.js";
import { deleteProjectRecord } from "../services.js";
import { ensureProject } from "../seed.js";

const V = "/rest/api/:v{[23]}";
const READ = ["read:jira-work"];
const MANAGE = ["manage:jira-project", "manage:jira-configuration"];
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

function requireAdmin(r: JiraRequest) {
  if (!r.user.admin) {
    throw new JiraError(403, ["You must have global administrator rights in order to modify projects."]);
  }
}

export function projectRoutes({ app, store, baseUrl }: RouteContext): void {
  const handle = makeHandler(store, baseUrl);

  app.get(
    `${V}/project`,
    handle((r) => r.c.json(r.js.projects.all().map((project) => formatProject(r, project))), { scopes: READ }),
  );

  app.get(
    `${V}/project/search`,
    handle(
      (r) => {
        const query = r.c.req.query("query")?.toLowerCase();
        const keys = listParam(r.c, "keys").map((key) => key.toLowerCase());
        const ids = listParam(r.c, "id");
        const typeKey = r.c.req.query("typeKey");
        const projects = r.js.projects.all().filter((project) => {
          if (query && !project.key.toLowerCase().includes(query) && !project.name.toLowerCase().includes(query)) {
            return false;
          }
          if (keys.length > 0 && !keys.includes(project.key.toLowerCase())) return false;
          if (ids.length > 0 && !ids.includes(String(project.id))) return false;
          if (typeKey && project.project_type_key !== typeKey) return false;
          return true;
        });
        const startAt = intParam(r.c.req.query("startAt"), 0);
        const maxResults = intParam(r.c.req.query("maxResults"), 50, 100);
        const page = paginate(projects, startAt, maxResults);
        return r.c.json({
          self: restUrl(r, `/project/search?startAt=${startAt}&maxResults=${maxResults}`),
          ...(page.isLast
            ? {}
            : { nextPage: restUrl(r, `/project/search?startAt=${startAt + maxResults}&maxResults=${maxResults}`) }),
          ...page,
          values: page.values.map((project) => formatProject(r, project)),
        });
      },
      { scopes: READ },
    ),
  );

  app.post(
    `${V}/project`,
    handle(
      async (r) => {
        requireAdmin(r);
        const body = await readJson(r.c);
        const key = String(body.key ?? "");
        const name = String(body.name ?? "").trim();
        if (!PROJECT_KEY.test(key)) {
          throw fieldError(
            "projectKey",
            "Project keys must start with an uppercase letter, followed by one or more uppercase alphanumeric characters.",
          );
        }
        if (findProject(r.js, key))
          throw fieldError(
            "projectKey",
            `Project '${key}' uses this project key. A project with that project key already exists.`,
          );
        if (!name) throw fieldError("projectName", "You must specify a valid project name.");
        if (r.js.projects.all().some((project) => project.name.toLowerCase() === name.toLowerCase())) {
          throw fieldError("projectName", "A project with that name already exists.");
        }
        const typeKey = body.projectTypeKey ?? "software";
        if (!["software", "business", "service_desk"].includes(typeKey)) {
          throw fieldError("projectTypeKey", "Invalid project type key.");
        }
        let lead = r.user.account_id;
        if (body.leadAccountId) {
          const user = findUser(r.js, String(body.leadAccountId));
          if (!user) throw fieldError("projectLead", "The project lead you specified does not exist.");
          lead = user.account_id;
        }
        const project = ensureProject(store, {
          key,
          name,
          description: body.description ?? "",
          lead,
          project_type_key: typeKey,
        });
        return r.c.json({ self: restUrl(r, `/project/${project.id}`), id: project.id, key: project.key }, 201);
      },
      { scopes: MANAGE },
    ),
  );

  app.get(
    `${V}/project/:key`,
    handle((r) => r.c.json(formatProject(r, requireProject(r.js, r.c.req.param("key")))), { scopes: READ }),
  );

  app.put(
    `${V}/project/:key`,
    handle(
      async (r) => {
        requireAdmin(r);
        const project = requireProject(r.js, r.c.req.param("key"));
        const body = await readJson(r.c);
        const patch: Partial<typeof project> = {};
        if (typeof body.name === "string") patch.name = body.name;
        if (typeof body.description === "string") patch.description = body.description;
        if (typeof body.key === "string" && body.key !== project.key) {
          if (!PROJECT_KEY.test(body.key)) throw fieldError("projectKey", "Invalid project key.");
          if (findProject(r.js, body.key))
            throw fieldError("projectKey", "A project with that project key already exists.");
          patch.key = body.key;
        }
        if (body.leadAccountId) {
          const user = findUser(r.js, String(body.leadAccountId));
          if (!user) throw fieldError("projectLead", "The project lead you specified does not exist.");
          patch.lead_account_id = user.account_id;
        }
        const updated = r.js.projects.update(project.id, patch)!;
        if (patch.key) {
          for (const issue of r.js.issues.findBy("project_id", project.id)) {
            r.js.issues.update(issue.id, { key: `${patch.key}-${issue.number}` });
          }
        }
        return r.c.json(formatProject(r, updated));
      },
      { scopes: MANAGE },
    ),
  );

  app.delete(
    `${V}/project/:key`,
    handle(
      (r) => {
        requireAdmin(r);
        deleteProjectRecord(r.js, requireProject(r.js, r.c.req.param("key")));
        return r.c.body(null, 204);
      },
      { scopes: MANAGE },
    ),
  );

  app.get(
    `${V}/project/:key/components`,
    handle(
      (r) => {
        const project = requireProject(r.js, r.c.req.param("key"));
        return r.c.json(
          r.js.components.findBy("project_id", project.id).map((component) => formatComponent(r, component)),
        );
      },
      { scopes: READ },
    ),
  );

  app.get(
    `${V}/project/:key/versions`,
    handle(
      (r) => {
        const project = requireProject(r.js, r.c.req.param("key"));
        return r.c.json(r.js.versions.findBy("project_id", project.id).map((version) => formatVersion(r, version)));
      },
      { scopes: READ },
    ),
  );

  app.post(
    `${V}/component`,
    handle(
      async (r) => {
        const body = await readJson(r.c);
        const project = findProject(r.js, body.projectId ?? body.project);
        if (!project) throw fieldError("project", "The project with key or id specified does not exist.");
        const name = String(body.name ?? "").trim();
        if (!name) throw fieldError("name", "The component name must not be empty.");
        if (r.js.components.findBy("project_id", project.id).some((c) => c.name.toLowerCase() === name.toLowerCase())) {
          throw fieldError("name", `A component with the name ${name} already exists in this project.`);
        }
        const lead = body.leadAccountId ? findUser(r.js, String(body.leadAccountId)) : undefined;
        const component = insertFrom(r.js.components, 10000, {
          project_id: project.id,
          name,
          description: body.description ?? "",
          lead_account_id: lead?.account_id ?? null,
        });
        return r.c.json(formatComponent(r, component), 201);
      },
      { scopes: MANAGE },
    ),
  );

  const requireComponent = (r: JiraRequest) => {
    const component = r.js.components.get(Number(r.c.req.param("id")));
    if (!component) throw new JiraError(404, [`The component with id ${r.c.req.param("id")} does not exist.`]);
    return component;
  };

  app.get(
    `${V}/component/:id`,
    handle((r) => r.c.json(formatComponent(r, requireComponent(r))), { scopes: READ }),
  );

  app.put(
    `${V}/component/:id`,
    handle(
      async (r) => {
        const component = requireComponent(r);
        const body = await readJson(r.c);
        const updated = r.js.components.update(component.id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
        })!;
        return r.c.json(formatComponent(r, updated));
      },
      { scopes: MANAGE },
    ),
  );

  app.delete(
    `${V}/component/:id`,
    handle(
      (r) => {
        const component = requireComponent(r);
        for (const issue of r.js.issues.findBy("project_id", component.project_id)) {
          if (issue.component_ids.includes(component.id)) {
            r.js.issues.update(issue.id, { component_ids: issue.component_ids.filter((id) => id !== component.id) });
          }
        }
        r.js.components.delete(component.id);
        return r.c.body(null, 204);
      },
      { scopes: MANAGE },
    ),
  );

  app.post(
    `${V}/version`,
    handle(
      async (r) => {
        const body = await readJson(r.c);
        const project = findProject(r.js, body.projectId ?? body.project);
        if (!project) throw fieldError("project", "The project with key or id specified does not exist.");
        const name = String(body.name ?? "").trim();
        if (!name) throw fieldError("name", "You must specify a valid version name");
        if (r.js.versions.findBy("project_id", project.id).some((v) => v.name.toLowerCase() === name.toLowerCase())) {
          throw fieldError("name", "A version with this name already exists in this project.");
        }
        const version = insertFrom(r.js.versions, 10000, {
          project_id: project.id,
          name,
          description: body.description ?? "",
          released: body.released === true,
          archived: body.archived === true,
          start_date: body.startDate ?? null,
          release_date: body.releaseDate ?? null,
        });
        return r.c.json(formatVersion(r, version), 201);
      },
      { scopes: MANAGE },
    ),
  );

  const requireVersion = (r: JiraRequest) => {
    const version = r.js.versions.get(Number(r.c.req.param("id")));
    if (!version) throw new JiraError(404, [`Could not find version for id '${r.c.req.param("id")}'`]);
    return version;
  };

  app.get(
    `${V}/version/:id`,
    handle((r) => r.c.json(formatVersion(r, requireVersion(r))), { scopes: READ }),
  );

  app.put(
    `${V}/version/:id`,
    handle(
      async (r) => {
        const version = requireVersion(r);
        const body = await readJson(r.c);
        const updated = r.js.versions.update(version.id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.released === "boolean" ? { released: body.released } : {}),
          ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
          ...(body.startDate !== undefined ? { start_date: body.startDate } : {}),
          ...(body.releaseDate !== undefined ? { release_date: body.releaseDate } : {}),
        })!;
        return r.c.json(formatVersion(r, updated));
      },
      { scopes: MANAGE },
    ),
  );

  app.delete(
    `${V}/version/:id`,
    handle(
      (r) => {
        const version = requireVersion(r);
        for (const issue of r.js.issues.findBy("project_id", version.project_id)) {
          if (issue.fix_version_ids.includes(version.id)) {
            r.js.issues.update(issue.id, { fix_version_ids: issue.fix_version_ids.filter((id) => id !== version.id) });
          }
        }
        r.js.versions.delete(version.id);
        return r.c.body(null, 204);
      },
      { scopes: MANAGE },
    ),
  );
}
