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
      return dbx.updateJson(indexPath(), mutate, () => ({ schema: 1, projects: [] }));
    },

    async loadProject(pid) {
      const res = await dbx.downloadJson(projectPath(pid));
      if (!res) throw new Error(`Project ${pid} not found in Dropbox`);
      return res.data;
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

    async addComment(pid, vid, { author, timeSec, text, annotation, version }) {
      const comment = {
        id: uid("c"),
        version,
        author: author || "Owner",
        isOwner: true,
        timeSec,
        text,
        resolved: false,
        createdAt: new Date().toISOString(),
        annotation: annotation || null,
      };
      if (viaWorker()) {
        const res = await api.adminComment({ action: "add", projectId: pid, videoId: vid, comment });
        return res.comment;
      }
      await dbx.updateJson(
        commentsPath(pid, vid),
        (data) => ({ ...data, comments: [...data.comments, comment] }),
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
        (data) => ({ ...data, comments: data.comments.filter((c) => c.id !== commentId) }),
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

    async addComment(_pid, _vid, { author, timeSec, text, annotation, version }) {
      const res = await api.postComment(token, { author, timeSec, text, annotation, version });
      return res.comment;
    },

    async mediaLinkForVersion(version) {
      const res = await api.getMedia(token, version);
      return { url: res.mediaUrl, expiresAt: res.mediaExpiresAt };
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

export function newVideoEntry(name, fps) {
  return {
    id: uid("vid"),
    name,
    fps: fps || CONFIG.DEFAULT_FPS,
    status: "in_review",
    currentVersion: 0,
    versions: [],
  };
}
