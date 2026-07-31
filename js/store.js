// Data layer with two interchangeable backends:
//   ownerStore()          → talks to Dropbox directly (auth.js/dropbox.js);
//                           comment WRITES route through the worker when it's
//                           configured, so the worker stays the single writer
//                           for comments files (no owner-vs-reviewer races).
//   reviewerStore(token)  → talks only to the Cloudflare Worker.
//
// Both expose the same interface consumed by the review screen.

import * as dbx from "./dropbox.js";
import * as api from "./worker-api.js";
import { uid } from "./ui.js";
import { CONFIG } from "./config.js";

const indexPath = () => "/index.json";
const projectPath = (pid) => `/projects/${pid}/project.json`;
const commentsPath = (pid, vid) => `/projects/${pid}/comments/${vid}.json`;
export const mediaDir = (pid, vid) => `/projects/${pid}/media/${vid}`;

const emptyComments = (videoId) => ({ schema: 1, videoId, comments: [] });

export function ownerStore() {
  // Comment writes go through the worker when both the worker URL and the
  // admin key are set; otherwise fall back to direct CAS writes so the app
  // is fully usable before the worker exists.
  const viaWorker = () => api.adminConfigured();

  return {
    mode: "owner",

    async loadIndex() {
      const res = await dbx.downloadJson(indexPath());
      return res?.data ?? { schema: 1, projects: [] };
    },

    async updateIndex(mutate) {
      const next = await dbx.updateJson(indexPath(), mutate, () => ({ schema: 1, projects: [] }));
      // The one choke point every project create/rename/delete passes through
      // (see createProject/deleteProject/renameProject below), so the sidebar
      // can stay in sync without its own copy of "what changes the list."
      window.dispatchEvent(new CustomEvent("kontraframe:index-changed", { detail: next }));
      return next;
    },

    async loadProject(pid) {
      const res = await dbx.downloadJson(projectPath(pid));
      if (!res) throw new Error(`Project ${pid} not found in Dropbox`);
      // Defaulted at read time rather than migrated on disk, the same way
      // loadIndex defaults a missing index.json — a project saved before
      // folders existed has no `groups` key, and every video in it is
      // implicitly ungrouped rather than missing a `groupId` it never needed.
      return { groups: [], ...res.data };
    },

    async updateProject(pid, mutate) {
      return dbx.updateJson(projectPath(pid), mutate, () => {
        throw new Error(`Project ${pid} not found in Dropbox`);
      });
    },

    async loadComments(pid, vid) {
      const res = await dbx.downloadJson(commentsPath(pid, vid));
      return (res?.data ?? emptyComments(vid)).comments;
    },

    async addComment(pid, vid, { author, timeSec, text, annotation, version, parentId = null }) {
      const comment = {
        id: uid("c"),
        version,
        author: author || "Owner",
        isOwner: true,
        timeSec,
        text,
        resolved: false,
        createdAt: new Date().toISOString(),
        // A reply is text on an existing note; drawings belong to the note.
        annotation: parentId ? null : annotation || null,
        parentId,
      };
      if (viaWorker()) {
        const res = await api.adminComment({ action: "add", projectId: pid, videoId: vid, comment });
        return res.comment;
      }
      await dbx.updateJson(
        commentsPath(pid, vid),
        (data) => {
          if (comment.parentId) {
            const parent = data.comments.find((c) => c.id === comment.parentId);
            if (!parent) throw new Error("The comment being replied to no longer exists");
            if (parent.parentId) comment.parentId = parent.parentId; // keep threads flat
            comment.timeSec = parent.timeSec;
            comment.version = parent.version;
          }
          return { ...data, comments: [...data.comments, comment] };
        },
        () => emptyComments(vid)
      );
      return comment;
    },

    async setResolved(pid, vid, commentId, resolved) {
      if (viaWorker()) {
        await api.adminComment({ action: "resolve", projectId: pid, videoId: vid, commentId, resolved });
        return;
      }
      await dbx.updateJson(
        commentsPath(pid, vid),
        (data) => ({
          ...data,
          comments: data.comments.map((c) => (c.id === commentId ? { ...c, resolved } : c)),
        }),
        () => emptyComments(vid)
      );
    },

    async deleteComment(pid, vid, commentId) {
      if (viaWorker()) {
        await api.adminComment({ action: "delete", projectId: pid, videoId: vid, commentId });
        return;
      }
      await dbx.updateJson(
        commentsPath(pid, vid),
        (data) => ({
          ...data,
          // Replies go with their parent, or they'd be stranded.
          comments: data.comments.filter((c) => c.id !== commentId && c.parentId !== commentId),
        }),
        () => emptyComments(vid)
      );
    },

    // Returns {url, expiresAt} for a media path.
    mediaLink(path) {
      return dbx.getTemporaryLink(path);
    },
  };
}

export function reviewerStore(token) {
  return {
    mode: "reviewer",
    token,

    async loadComments() {
      const res = await api.getComments(token);
      return res.comments;
    },

    async addComment(_pid, _vid, { author, timeSec, text, annotation, version, parentId = null }) {
      const res = await api.postComment(token, { author, timeSec, text, annotation, version, parentId });
      return res.comment;
    },

    async mediaLinkForVersion(version) {
      const res = await api.getMedia(token, version);
      return { url: res.mediaUrl, expiresAt: res.mediaExpiresAt };
    },

    // The worker writes project.json; reviewers have no Dropbox access.
    async setStatus(status) {
      await api.postStatus(token, status);
    },
  };
}

// Owner helpers used by the project browser.

export async function createProject(store, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "project";
  const id = `${slug}-${uid()}`;
  const project = { schema: 1, id, name, createdAt: new Date().toISOString(), videos: [] };
  await dbx.uploadJson(projectPath(id), project);
  await store.updateIndex((data) => ({
    ...data,
    projects: [...data.projects, { id, name, createdAt: project.createdAt }],
  }));
  return project;
}

// A project's name is written twice: in the index the grid reads, and in the
// project's own file. Both have to move together.
//
// The project file goes first. If the index write then fails, the grid the
// rename was started from is still showing the old name — visibly unchanged,
// which is a better thing to hand back than a grid and a project page that
// quietly disagree. The folder in Dropbox keeps the name it was created with;
// share links point at the id, so nothing breaks.
export async function renameProject(store, pid, name) {
  await store.updateProject(pid, (project) => ({ ...project, name }));
  await store.updateIndex((data) => ({
    ...data,
    projects: data.projects.map((p) => (p.id === pid ? { ...p, name } : p)),
  }));
}

// Revoke share links pointing at content that's about to vanish, so reviewers
// get "this link is no longer active" instead of a bare server error.
// Best effort — the worker may not be configured, and a failure here must not
// block the delete itself.
async function revokeSharesFor(matches) {
  if (!api.adminConfigured()) return 0;
  try {
    const { shares } = await api.listShares();
    const doomed = shares.filter((s) => !s.revoked && matches(s));
    for (const share of doomed) await api.revokeShare(share.token);
    return doomed.length;
  } catch {
    return 0;
  }
}

// Both deletes drop the metadata first: if the Dropbox cleanup then fails the
// app's own state is still consistent, and only unreferenced files are left
// behind. The reverse order would leave the UI pointing at content it can't
// load. `filesRemoved: false` says exactly that happened, so callers can tell
// the user rather than claiming a clean delete.
export async function deleteVideo(store, pid, vid) {
  const revoked = await revokeSharesFor((s) => s.projectId === pid && s.videoId === vid);
  await store.updateProject(pid, (project) => ({
    ...project,
    videos: project.videos.filter((v) => v.id !== vid),
  }));
  let filesRemoved = true;
  try {
    await dbx.deleteFile(mediaDir(pid, vid));
    await dbx.deleteFile(commentsPath(pid, vid));
  } catch {
    filesRemoved = false;
  }
  return { revoked, filesRemoved };
}

export async function deleteProject(store, pid) {
  const revoked = await revokeSharesFor((s) => s.projectId === pid);
  await store.updateIndex((data) => ({
    ...data,
    projects: data.projects.filter((p) => p.id !== pid),
  }));
  let filesRemoved = true;
  try {
    await dbx.deleteFile(`/projects/${pid}`);
  } catch {
    filesRemoved = false;
  }
  return { revoked, filesRemoved };
}

export function newVideoEntry(name, fps, groupId = null) {
  return {
    id: uid("vid"),
    name,
    fps: fps || CONFIG.DEFAULT_FPS,
    status: "in_review",
    currentVersion: 0,
    versions: [],
    groupId,
  };
}

// Folders inside a project. Videos stay in one flat array with an optional
// groupId rather than nesting under their group — every place that already
// looks a video up by id (the review route, share links, delete) keeps
// working unchanged, and only the browsing screen needs to know groups exist.

export function newGroup(name) {
  return { id: uid("grp"), name, createdAt: new Date().toISOString() };
}

export async function createGroup(store, pid, name) {
  const group = newGroup(name);
  await store.updateProject(pid, (project) => ({
    ...project,
    groups: [...(project.groups || []), group],
  }));
  return group;
}

export async function renameGroup(store, pid, gid, name) {
  await store.updateProject(pid, (project) => ({
    ...project,
    groups: (project.groups || []).map((g) => (g.id === gid ? { ...g, name } : g)),
  }));
}

// Ungroups rather than deletes: a folder organises videos, it doesn't own
// them, so removing it should not take reviewed footage and its comments
// down as collateral. Its videos land back at the project root.
export async function deleteGroup(store, pid, gid) {
  await store.updateProject(pid, (project) => ({
    ...project,
    groups: (project.groups || []).filter((g) => g.id !== gid),
    videos: project.videos.map((v) => (v.groupId === gid ? { ...v, groupId: null } : v)),
  }));
}

export async function moveVideoToGroup(store, pid, vid, groupId) {
  await store.updateProject(pid, (project) => ({
    ...project,
    videos: project.videos.map((v) => (v.id === vid ? { ...v, groupId } : v)),
  }));
}
